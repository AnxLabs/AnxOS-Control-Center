// Hermetic smoke for src/services/operationalNotificationService.js (the
// main-process operational notification journal).
//
// Covered contract:
//   - running -> stopped emits exactly one warning; staying stopped is silent;
//     recovery emits one info and resolves the original event
//   - first observation seeds state only (no initial spam), and a transition
//     into a problem state emits exactly one event
//   - restart persistence: a fresh instance over the same store never
//     re-notifies an unchanged state, and still detects the next transition
//   - crash-loop / provider disconnect / endpoint health / failed-backup
//     variants, each with the specified severity, category and title
//   - dedupe window: state flips inside the window are suppressed entirely
//   - store cap of 200 (unresolved retained), list limit clamp and since cursor
//   - redaction of message and technical details
//   - scheduler start/stop idempotence, overlap guard, and an evaluation that
//     never throws when the collector is unreachable
//   - the DI-only state collector attaches cached endpoint health and degrades
//     to empty collections when a dependency fails
//
// Roots are pinned before any src module loads so nothing leaks into the real
// machine (same helper as the other service smokes).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("node:module");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const smokeRoot = pinAgentRoots("anx-operational-notifications-");

const {
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  SEVERITIES,
  CATEGORIES,
  createOperationalNotificationService,
  createOperationalNotificationCollector,
  startOperationalNotificationScheduler,
  stopOperationalNotificationScheduler,
  listOperationalNotifications,
  evaluateOperationalNotifications,
} = require("../src/services/operationalNotificationService");

let clockMs = Date.parse("2026-02-01T12:00:00.000Z");
function at(iso) {
  clockMs = Date.parse(iso);
}
const now = () => clockMs;

let scenarioCounter = 0;
function storeFile(label) {
  scenarioCounter += 1;
  return path.join(smokeRoot, `${label}-${scenarioCounter}.json`);
}

function createService(filePath, extra = {}) {
  return createOperationalNotificationService({ storePath: filePath, now, ...extra });
}

function readStore(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeRow(nodeId, state, name) {
  return { nodeId, name: name || nodeId, state };
}

function instanceRow(nodeId, instanceId, state, extra = {}) {
  return { nodeId, instanceId, state, ...extra };
}

// ---------------------------------------------------------------------------
// Phase 1: transition lifecycle (warning, dedup, recovery + resolution).
// ---------------------------------------------------------------------------
async function phaseTransitionLifecycle() {
  const file = storeFile("lifecycle");
  const service = createService(file);

  at("2026-02-01T12:00:00.000Z");
  const seeded = await service.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-a", "inst-1", "Running")] }),
  });
  assert.strictEqual(seeded.ok, true, "evaluation must succeed");
  assert.strictEqual(seeded.events.length, 0, "the first observation must seed without an event");

  at("2026-02-01T12:01:00.000Z");
  const stopped = await service.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-a", "inst-1", "Stopped")] }),
  });
  assert.strictEqual(stopped.events.length, 1, "running -> stopped must emit exactly one event");
  const warning = stopped.events[0];
  assert.strictEqual(warning.severity, "warning", "a stopped service is a warning");
  assert.strictEqual(warning.category, "service", "a stopped service is a service event");
  assert.strictEqual(warning.title, "Service stopped unexpectedly", "the warning title must match the contract");
  assert.strictEqual(warning.resolvedAt, null, "a fresh event is unresolved");
  assert.match(warning.id, /^ntf-[0-9a-f]{16}$/, "event ids must be ntf-<sha256 prefix>");

  for (const minute of [2, 3, 4]) {
    at(`2026-02-01T12:0${minute}:00.000Z`);
    const repeat = await service.evaluate({
      collectState: async () => ({ instances: [instanceRow("node-a", "inst-1", "Stopped")] }),
    });
    assert.strictEqual(repeat.events.length, 0, "staying stopped must not re-notify");
  }

  // The recovery lands inside the 10 minute window on purpose: resolutions are
  // window-exempt so the original event is never left unresolved.
  at("2026-02-01T12:05:00.000Z");
  const recovered = await service.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-a", "inst-1", "Running")] }),
  });
  assert.strictEqual(recovered.events.length, 1, "recovery must emit exactly one event");
  assert.strictEqual(recovered.events[0].severity, "info", "a recovery is info");
  assert.strictEqual(recovered.events[0].title, "Service running again", "the recovery title must match the contract");

  const stored = readStore(file);
  assert.strictEqual(stored.schemaVersion, NOTIFICATION_EVENT_SCHEMA_VERSION, "the store must carry schemaVersion 1");
  assert.strictEqual(stored.events.length, 2, "only the warning and its recovery may be stored");
  const original = stored.events.find((event) => event.id === warning.id);
  assert(original, "the warning must persist in the store");
  assert.strictEqual(original.resolvedAt, "2026-02-01T12:05:00.000Z", "recovery must set resolvedAt on the original event");
  const stateEntry = stored.state["instance:node-a:inst-1"];
  assert(stateEntry && stateEntry.state === "running", "the state map must record the latest observed state");
  assert.strictEqual(stateEntry.lastNotifiedAt, "2026-02-01T12:05:00.000Z", "the state map must record the last notification");
}

// ---------------------------------------------------------------------------
// Phase 2: first-observation seeding (no initial spam).
// ---------------------------------------------------------------------------
async function phaseFirstObservationSeeding() {
  const file = storeFile("seeding");
  const service = createService(file);

  at("2026-02-01T13:00:00.000Z");
  const firstOffline = await service.evaluate({
    collectState: async () => ({ nodes: [nodeRow("node-seed", "offline")] }),
  });
  assert.strictEqual(firstOffline.events.length, 0, "a first observation of an offline node must not emit");

  at("2026-02-01T13:01:00.000Z");
  const stillOffline = await service.evaluate({
    collectState: async () => ({ nodes: [nodeRow("node-seed", "offline")] }),
  });
  assert.strictEqual(stillOffline.events.length, 0, "an unchanged offline observation must not emit");

  at("2026-02-01T13:02:00.000Z");
  const online = await service.evaluate({
    collectState: async () => ({ nodes: [nodeRow("node-seed", "online")] }),
  });
  assert.strictEqual(online.events.length, 0, "a recovery with no announced problem must stay silent");

  at("2026-02-01T13:03:00.000Z");
  const transition = await service.evaluate({
    collectState: async () => ({ nodes: [nodeRow("node-seed", "offline")] }),
  });
  assert.strictEqual(transition.events.length, 1, "online -> offline must emit the first event");
  assert.strictEqual(transition.events[0].severity, "critical", "a disconnected machine is critical");
  assert.strictEqual(transition.events[0].category, "agent", "a disconnected machine is an agent event");
  assert.strictEqual(transition.events[0].title, "Machine disconnected", "the disconnect title must match the contract");
  assert(transition.events[0].message.includes("node-seed"), "the message must include the machine name");
  assert(transition.events[0].message.includes("offline"), "the message must include the raw state");
  assert.deepStrictEqual(
    transition.events[0].action,
    { id: "open-nodes", target: { nodeId: "node-seed" } },
    "the node event must carry its open-nodes action link",
  );
}

// ---------------------------------------------------------------------------
// Phase 3: restart persistence.
// ---------------------------------------------------------------------------
async function phaseRestartPersistence() {
  const file = storeFile("restart");
  const first = createService(file);

  at("2026-02-01T14:00:00.000Z");
  await first.evaluate({ collectState: async () => ({ instances: [instanceRow("node-r", "inst-r", "Running")] }) });
  at("2026-02-01T14:01:00.000Z");
  const warning = await first.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-r", "inst-r", "Stopped")] }),
  });
  assert.strictEqual(warning.events.length, 1, "the first stop must notify");

  // "Restart": a fresh instance reading the same store.
  const second = createService(file);
  at("2026-02-01T14:02:00.000Z");
  const afterRestart = await second.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-r", "inst-r", "Stopped")] }),
  });
  assert.strictEqual(afterRestart.events.length, 0, "a restart must not re-notify an unchanged state");

  at("2026-02-01T14:03:00.000Z");
  const recovery = await second.evaluate({
    collectState: async () => ({ instances: [instanceRow("node-r", "inst-r", "Running")] }),
  });
  assert.strictEqual(recovery.events.length, 1, "state continuity across a restart must still detect the recovery");
  assert.strictEqual(recovery.events[0].title, "Service running again", "the restart recovery must be the info event");

  const stored = readStore(file);
  assert.strictEqual(stored.events.length, 2, "a restart must not duplicate the warning");
  const original = stored.events.find((event) => event.id === warning.events[0].id);
  assert(original, "the pre-restart warning must survive in the store");
  assert.strictEqual(original.resolvedAt, "2026-02-01T14:03:00.000Z", "the restart recovery must resolve the original event");
}

// ---------------------------------------------------------------------------
// Phase 4: crash loop, provider disconnect, endpoint health, failed backup.
// ---------------------------------------------------------------------------
async function phaseVariants() {
  const file = storeFile("variants");
  const service = createService(file);

  at("2026-02-01T15:00:00.000Z");
  await service.evaluate({
    collectState: async () => ({
      instances: [instanceRow("node-v", "inst-loop", "Running"), instanceRow("node-v", "inst-plain", "Running")],
      providers: [{ nodeId: "node-v", providerId: "playit", name: "Playit.gg", lifecycleState: "running", connected: true }],
      endpoints: [{ endpointId: "ep-1", nodeId: "node-v", name: "Game port", health: { state: "healthy" } }],
    }),
  });

  at("2026-02-01T15:01:00.000Z");
  const crashed = await service.evaluate({
    collectState: async () => ({
      instances: [
        instanceRow("node-v", "inst-loop", "Stopped", { healthState: "crash-loop" }),
        instanceRow("node-v", "inst-plain", "Failed"),
      ],
      providers: [{ nodeId: "node-v", providerId: "playit", name: "Playit.gg", lifecycleState: "not-installed", connected: false, installed: false }],
      endpoints: [{ endpointId: "ep-1", nodeId: "node-v", name: "Game port", health: { state: "failed" } }],
    }),
  });
  const byKey = new Map(crashed.events.map((event) => [event.dedupKey, event]));

  const loop = byKey.get("instance:node-v:inst-loop");
  assert(loop, "the crash-loop instance must emit");
  assert.strictEqual(loop.severity, "critical", "a crash loop is critical");
  assert.strictEqual(loop.title, "Service crash loop", "a crash loop must use the crash-loop title");

  const plain = byKey.get("instance:node-v:inst-plain");
  assert(plain, "the failed instance must emit");
  assert.strictEqual(plain.severity, "critical", "running -> failed is critical");
  assert.strictEqual(plain.title, "Service crashed", "a plain failure must use the crashed title");

  const provider = byKey.get("provider:node-v:playit");
  assert(provider, "the provider disconnect must emit");
  assert.strictEqual(provider.severity, "critical", "connected -> not-installed is critical");
  assert.strictEqual(provider.title, "Tunnel provider disconnected", "the provider title must match the contract");
  assert.deepStrictEqual(provider.action, { id: "open-network", target: { nodeId: "node-v", providerId: "playit" } }, "provider events link to the network page");

  const endpoint = byKey.get("endpoint:ep-1");
  assert(endpoint, "the endpoint failure must emit");
  assert.strictEqual(endpoint.severity, "warning", "healthy -> failed is a warning");
  assert.strictEqual(endpoint.title, "Endpoint became unavailable", "the endpoint title must match the contract");

  // An endpoint without health.state is never observed (no probe, no event).
  at("2026-02-01T15:02:00.000Z");
  const noHealth = await service.evaluate({
    collectState: async () => ({
      endpoints: [{ endpointId: "ep-2", name: "No diagnostics" }],
      backups: [{ nodeId: "node-v", instanceId: "inst-b", backupId: "bk-1", status: "failed" }],
    }),
  });
  assert.strictEqual(noHealth.events.length, 1, "only the failed backup may notify here");
  assert.strictEqual(noHealth.events[0].category, "backup", "a failed backup is a backup event");
  assert.strictEqual(noHealth.events[0].title, "Backup failed", "the backup title must match the contract");

  at("2026-02-01T15:03:00.000Z");
  const backupAgain = await service.evaluate({
    collectState: async () => ({
      backups: [
        { nodeId: "node-v", instanceId: "inst-b", backupId: "bk-1", status: "failed" },
        { nodeId: "node-v", instanceId: "inst-b", backupId: "bk-2", verification: { status: "failed" } },
      ],
    }),
  });
  assert.strictEqual(backupAgain.events.length, 1, "the same backupId never re-notifies; a new backupId still does");
  assert.strictEqual(backupAgain.events[0].dedupKey, "backup:node-v:inst-b:bk-2", "the new backup id must be the one that notified");

  at("2026-02-01T15:10:00.000Z");
  const providerBack = await service.evaluate({
    collectState: async () => ({
      providers: [{ nodeId: "node-v", providerId: "playit", name: "Playit.gg", lifecycleState: "running", connected: true }],
    }),
  });
  assert.strictEqual(providerBack.events.length, 1, "the provider recovery must emit");
  assert.strictEqual(providerBack.events[0].severity, "info", "the provider recovery is info");
  assert.strictEqual(providerBack.events[0].title, "Tunnel provider connected", "the provider recovery title must match the contract");
  const stored = readStore(file);
  const providerWarning = stored.events.find((event) => event.id === provider.id);
  assert(providerWarning, "the provider warning must persist");
  assert.strictEqual(providerWarning.resolvedAt, "2026-02-01T15:10:00.000Z", "the provider recovery must resolve the original critical");
}

// ---------------------------------------------------------------------------
// Phase 5: dedupe window.
// ---------------------------------------------------------------------------
async function phaseDedupeWindow() {
  const file = storeFile("dedupe");
  const service = createService(file, { dedupeWindowMs: 10 * 60 * 1000 });

  at("2026-02-01T16:00:00.000Z");
  await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "online")] }) });
  at("2026-02-01T16:01:00.000Z");
  const firstOffline = await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "offline")] }) });
  assert.strictEqual(firstOffline.events.length, 1, "the first offline transition must notify");

  at("2026-02-01T16:02:00.000Z");
  const recovery = await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "online")] }) });
  assert.strictEqual(recovery.events.length, 1, "the announced recovery must emit its info event");

  at("2026-02-01T16:03:00.000Z");
  const suppressedOne = await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "offline")] }) });
  assert.strictEqual(suppressedOne.events.length, 0, "an offline flip inside the dedupe window must be suppressed entirely");

  at("2026-02-01T16:04:00.000Z");
  const silentRecovery = await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "online")] }) });
  assert.strictEqual(silentRecovery.events.length, 0, "a recovery with nothing to resolve must stay silent");

  at("2026-02-01T16:05:00.000Z");
  const suppressedTwo = await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-d", "offline")] }) });
  assert.strictEqual(suppressedTwo.events.length, 0, "the second offline flip inside the window must also be suppressed");

  const stored = readStore(file);
  assert.strictEqual(stored.events.length, 2, "only the first warning and its recovery may be stored");
}

// ---------------------------------------------------------------------------
// Phase 6: store bounds (cap 200) and list cursor/limit semantics.
// ---------------------------------------------------------------------------
async function phaseBoundsAndCursor() {
  const cursorFile = storeFile("cursor");
  const cursorService = createService(cursorFile);
  at("2026-02-01T17:00:00.000Z");
  await cursorService.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-c", "online")] }) });
  at("2026-02-01T17:01:00.000Z");
  const firstEvent = await cursorService.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-c", "offline")] }) });
  at("2026-02-01T17:02:00.000Z");
  const recoveryEvent = await cursorService.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-c", "online")] }) });

  const all = cursorService.list({});
  assert.deepStrictEqual(
    all.events.map((event) => event.id),
    [recoveryEvent.events[0].id, firstEvent.events[0].id],
    "list must return newest first",
  );
  assert.strictEqual(all.cursor, recoveryEvent.events[0].id, "the cursor must be the newest event id");
  assert.strictEqual(all.degraded, false, "a healthy store must not be degraded");
  const sinceWarning = cursorService.list({ since: firstEvent.events[0].at });
  assert.deepStrictEqual(sinceWarning.events.map((event) => event.id), [recoveryEvent.events[0].id], "since must filter to strictly newer events");
  const sinceNewest = cursorService.list({ since: recoveryEvent.events[0].at });
  assert.strictEqual(sinceNewest.events.length, 0, "nothing is newer than the newest event");
  assert.strictEqual(sinceNewest.cursor, null, "an empty page has no cursor");

  const capFile = storeFile("cap");
  const capService = createService(capFile);
  const ids = Array.from({ length: 205 }, (_, index) => `node-cap-${String(index).padStart(3, "0")}`);
  at("2026-02-01T18:00:00.000Z");
  await capService.evaluate({ collectState: async () => ({ nodes: ids.map((id) => nodeRow(id, "online")) }) });
  at("2026-02-01T18:01:00.000Z");
  const burst = await capService.evaluate({ collectState: async () => ({ nodes: ids.map((id) => nodeRow(id, "offline")) }) });
  assert.strictEqual(burst.events.length, 205, "every distinct key may emit in one pass");
  const stored = readStore(capFile);
  assert.strictEqual(stored.events.length, 200, "the store must cap at 200 events");
  assert(stored.events.every((event) => event.resolvedAt === null), "unresolved events must be retained when trimming");
  assert.strictEqual(capService.list({}).events.length, 50, "the default page size is 50");
  assert.strictEqual(capService.list({ limit: 0 }).events.length, 1, "limit must clamp up to 1");
  assert.strictEqual(capService.list({ limit: 500 }).events.length, 100, "limit must clamp down to 100");
  assert.strictEqual(capService.list({ limit: "abc" }).events.length, 50, "a non-numeric limit falls back to the default");
}

// ---------------------------------------------------------------------------
// Phase 7: redaction of message + technical details.
// ---------------------------------------------------------------------------
async function phaseRedaction() {
  const file = storeFile("redaction");
  const service = createService(file);
  at("2026-02-01T19:00:00.000Z");
  await service.evaluate({ collectState: async () => ({ nodes: [nodeRow("node-secret", "online", "token=abc123 machine")] }) });
  at("2026-02-01T19:01:00.000Z");
  const emitted = await service.evaluate({
    collectState: async () => ({ nodes: [nodeRow("node-secret", "offline", "token=abc123 machine")] }),
  });
  assert.strictEqual(emitted.events.length, 1, "the disconnect must emit");

  const stored = readStore(file);
  const event = stored.events[0];
  assert(event.message.includes("[redacted]"), "the stored message must be redacted");
  assert(!event.message.includes("abc123"), "the raw secret must never be stored in a message");
  assert(event.technicalDetails.includes("[redacted]"), "technical details must be redacted");
  assert(!event.technicalDetails.includes("abc123"), "the raw secret must never be stored in technical details");
  assert(service.list({}).events[0].message.includes("[redacted]"), "listed events must stay redacted");
}

// ---------------------------------------------------------------------------
// Phase 8: scheduler, overlap guard, failure containment.
// ---------------------------------------------------------------------------
async function phaseSchedulerAndErrors() {
  const file = storeFile("scheduler");
  const service = createService(file);

  const failing = await service.evaluate({
    collectState: async () => {
      throw Object.assign(new Error("state layer down"), { code: "STATE_DOWN" });
    },
  });
  assert.strictEqual(failing.ok, false, "an unreachable collector must be reported");
  assert.strictEqual(failing.errorCode, "STATE_DOWN", "the collector failure code must surface");
  assert.deepStrictEqual(failing.events, [], "a failed evaluation emits nothing");

  const garbage = await service.evaluate({ collectState: async () => "not-an-object" });
  assert.strictEqual(garbage.ok, true, "malformed state must not throw");
  assert.deepStrictEqual(garbage.events, [], "malformed state emits nothing");

  // Overlap guard: a second pass while the first is in flight is skipped.
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = service.evaluate({ collectState: async () => { await gate; return {}; } });
  const overlapping = await service.evaluate({ collectState: async () => ({}) });
  assert.strictEqual(overlapping.skipped, true, "an overlapping evaluation must be skipped");
  release();
  const slowResult = await slow;
  assert.strictEqual(slowResult.ok, true, "the in-flight evaluation must complete normally");

  let passes = 0;
  const stopOne = service.start({ collectState: async () => { passes += 1; return {}; }, intervalMs: 10 });
  const stopTwo = service.start({ collectState: async () => { passes += 1; return {}; }, intervalMs: 10 });
  assert.strictEqual(typeof stopOne, "function", "start must return a stop handle");
  assert.strictEqual(typeof stopTwo, "function", "a second start must be idempotent and still return a stop handle");
  await delay(45);
  stopOne();
  stopTwo();
  const passesAtStop = passes;
  await delay(30);
  assert.strictEqual(passes, passesAtStop, "a stopped scheduler must not keep evaluating");
  assert(passesAtStop >= 1, "the scheduler must run an immediate first pass");
  service.stop();
  service.stop();

  // Module-level wrappers operate on the default instance (config dir pinned
  // into the smoke root by pinAgentRoots).
  const moduleList = listOperationalNotifications({});
  assert(Array.isArray(moduleList.events), "module-level list must return an events array");
  assert.strictEqual(moduleList.degraded, false, "a fresh default store is not degraded");
  const moduleEvaluation = await evaluateOperationalNotifications({ collectState: async () => ({}) });
  assert.strictEqual(moduleEvaluation.ok, true, "module-level evaluation must succeed");
  const moduleStop = startOperationalNotificationScheduler({ collectState: async () => ({}), intervalMs: 10 });
  stopOperationalNotificationScheduler();
  moduleStop();
}

// ---------------------------------------------------------------------------
// Phase 9: DI-only collector (health attach + failure containment).
// ---------------------------------------------------------------------------
async function phaseCollector() {
  const collector = createOperationalNotificationCollector({
    nodeService: {
      APPLICATION_HOST_NODE_ID: "app-host",
      getSelectedNodeId: () => "node-x",
      listNodes: async () => ({ nodes: [nodeRow("node-x", "online")] }),
    },
    alertService: { resolveInstanceSnapshot: async (nodeId, fetcher) => fetcher(nodeId) },
    serviceRouter: {
      listInstances: async () => ({ instances: [instanceRow("node-x", "inst-x", "Running")] }),
      // The injected router read path doubles as the backup source, so no lazy
      // require is needed here.
      listBackups: async () => ({ backups: [] }),
    },
    endpointService: {
      listEndpoints: async () => [
        { id: "ep-x", computerId: "node-x", serviceId: "inst-x", name: "Cached" },
        { id: "ep-uncached", computerId: "node-x", name: "No cache" },
      ],
    },
    providerIntegrationService: {
      getProviderSnapshot: async () => ({ providers: [{ nodeId: "node-x", providerId: "playit", lifecycleState: "running" }] }),
    },
    connectivityDiagnosticsService: {
      // Mirrors connectivityDiagnosticsService.getCachedDiagnostics: a real hit
      // carries cached:true + overall, a miss is the explicit NOT_EVALUATED
      // sentinel (never null, never a fabricated health state).
      getCachedDiagnostics: async ({ endpointId }) => (endpointId === "ep-x"
        ? { overall: { state: "healthy" }, cached: true, cachedAt: "2026-02-01T19:00:00.000Z" }
        : { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" }),
    },
  });

  const state = await collector();
  assert.strictEqual(state.nodes.length, 1, "the collector must read nodes");
  assert.strictEqual(state.instances.length, 1, "the collector must reuse the instance snapshot pattern");
  assert.strictEqual(state.providers.length, 1, "the collector must read provider snapshots");
  assert.strictEqual(state.endpoints[0].health.state, "healthy", "cached diagnostics must attach health.state");
  assert.strictEqual(state.endpoints[1].health, undefined, "no cached diagnostics means no health observation");
  assert.deepStrictEqual(state.backups, [], "the injected desktop read path returns no backups here");

  // A failing dependency must degrade that source to empty, never break a tick.
  const resilient = createOperationalNotificationCollector({
    nodeService: { listNodes: async () => { throw new Error("nodes down"); } },
    endpointService: { listEndpoints: async () => { throw new Error("endpoints down"); } },
    providerIntegrationService: { getProviderSnapshot: async () => { throw new Error("providers down"); } },
    connectivityDiagnosticsService: { getCachedDiagnostics: async () => { throw new Error("diagnostics down"); } },
  });
  const empty = await resilient();
  assert.deepStrictEqual(empty.nodes, [], "a failing node service must degrade to empty");
  assert.deepStrictEqual(empty.instances, [], "missing instance wiring must degrade to empty");
  assert.deepStrictEqual(empty.endpoints, [], "a failing endpoint service must degrade to empty");
  assert.deepStrictEqual(empty.providers, [], "a failing provider service must degrade to empty");
  assert.deepStrictEqual(empty.backups, [], "no effective node means the default backup source is skipped");

  const withBackups = createOperationalNotificationCollector({
    backupProvider: async () => ({ backups: [{ backupId: "bk-x", status: "failed" }] }),
  });
  const backupState = await withBackups();
  assert.strictEqual(backupState.backups.length, 1, "a passed backup provider must populate backups");
}

// ---------------------------------------------------------------------------
// Phase 10: identifier fallbacks (display names are redacted before storage).
// ---------------------------------------------------------------------------
async function phaseIdentifierFallbacks() {
  // An instance with no id/instanceId and a credential-shaped display name must
  // land in dedupKey/target/notifications.json only redacted, while the
  // transition still emits exactly once.
  const file = storeFile("identifier-fallback");
  const service = createService(file);
  const stateFor = (state) => ({ instances: [{ nodeId: "node-fb", name: "database password: hunter2", state }] });

  at("2026-02-01T20:00:00.000Z");
  const seeded = await service.evaluate({ collectState: async () => stateFor("Running") });
  assert.strictEqual(seeded.events.length, 0, "the fallback-identifier instance seeds without an event");

  at("2026-02-01T20:01:00.000Z");
  const emitted = await service.evaluate({ collectState: async () => stateFor("Stopped") });
  assert.strictEqual(emitted.events.length, 1, "the transition must still emit exactly once");
  const event = emitted.events[0];
  assert.strictEqual(event.dedupKey, "instance:node-fb:database password=[redacted]", "the fallback identifier must be redacted in dedupKey");
  assert.strictEqual(event.target.instanceId, "database password=[redacted]", "the fallback identifier must be redacted in target");
  assert(
    !event.dedupKey.includes("hunter2") && !event.target.instanceId.includes("hunter2"),
    "the raw secret must never reach identifier fields",
  );

  const storedText = fs.readFileSync(file, "utf8");
  assert(!storedText.includes("hunter2"), "notifications.json must not contain the instance name secret");
  assert(storedText.includes("[redacted]"), "notifications.json must carry the redaction placeholder");

  at("2026-02-01T20:02:00.000Z");
  const repeat = await service.evaluate({ collectState: async () => stateFor("Stopped") });
  assert.strictEqual(repeat.events.length, 0, "the redacted fallback identifier must stay stable for dedup");

  // The node display-name fallback (no nodeId/id) takes the same boundary.
  const nodeFile = storeFile("identifier-fallback-node");
  const nodeService = createService(nodeFile);
  const nodeState = (state) => ({ nodes: [{ name: "workstation token=abc123", state }] });
  at("2026-02-01T20:10:00.000Z");
  await nodeService.evaluate({ collectState: async () => nodeState("online") });
  at("2026-02-01T20:11:00.000Z");
  const nodeEvent = await nodeService.evaluate({ collectState: async () => nodeState("offline") });
  assert.strictEqual(nodeEvent.events.length, 1, "the node fallback transition must emit");
  assert.strictEqual(nodeEvent.events[0].dedupKey, "node:workstation token=[redacted]", "the node fallback must be redacted in dedupKey");
  assert(!JSON.stringify(nodeEvent.events[0]).includes("abc123"), "the node fallback secret must never reach the event");
  assert(!fs.readFileSync(nodeFile, "utf8").includes("abc123"), "notifications.json must not contain the node name secret");

  // Negative control: a well-formed id stays byte-identical (never redacted).
  const controlFile = storeFile("identifier-control");
  const controlService = createService(controlFile);
  const controlState = (state) => ({
    instances: [{ nodeId: "node-control", instanceId: "svc-abc123", name: "whatever token=abc123", state }],
  });
  at("2026-02-01T20:20:00.000Z");
  await controlService.evaluate({ collectState: async () => controlState("Running") });
  at("2026-02-01T20:21:00.000Z");
  const controlEvent = await controlService.evaluate({ collectState: async () => controlState("Stopped") });
  assert.strictEqual(controlEvent.events.length, 1, "the controlled transition must emit");
  assert.strictEqual(controlEvent.events[0].dedupKey, "instance:node-control:svc-abc123", "well-formed ids must remain byte-identical in dedupKey");
  assert.strictEqual(controlEvent.events[0].target.instanceId, "svc-abc123", "well-formed ids must remain byte-identical in target");
}

// ---------------------------------------------------------------------------
// Phase 11: backup default source (bounded lazy agent read path).
// ---------------------------------------------------------------------------
function backupRecord(id, options = {}) {
  return {
    id,
    instanceId: options.instanceId || "inst-b",
    status: options.status || "complete",
    createdAt: options.createdAt || "2026-02-01T21:00:00.000Z",
    ...(options.verification ? { verification: options.verification } : {}),
  };
}

// The default backup source lazily requires ./serviceRouter; stub it for the
// duration of `run` exactly like the IPC smoke stubs electron.
async function withStubbedServiceRouter(stub, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "./serviceRouter" && parent && String(parent.filename || "").endsWith("operationalNotificationService.js")) {
      return stub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
  }
}

function defaultBackupCollector() {
  return createOperationalNotificationCollector({
    nodeService: {
      APPLICATION_HOST_NODE_ID: "app-host",
      getSelectedNodeId: () => "node-backup",
      listNodes: async () => ({ nodes: [] }),
    },
  });
}

async function phaseBackupDefaultSource() {
  // Success: one bounded read scoped to the effective selected node, capped at
  // 50 records, with the agent verification.state mapped for the evaluator.
  const records = Array.from({ length: 51 }, (_, index) => backupRecord(`bk-${String(index).padStart(3, "0")}`, index === 0
    ? { verification: { state: "failed" } }
    : { verification: { state: "verified" } }));
  const calls = [];
  const collected = await withStubbedServiceRouter(
    { listBackups: async (options) => { calls.push(options); return { backups: records }; } },
    async () => defaultBackupCollector()(),
  );
  assert.strictEqual(calls.length, 1, "the default source must make exactly one bounded read");
  assert.deepStrictEqual(calls[0], { nodeId: "node-backup" }, "the default source must be scoped to the effective selected node");
  assert.strictEqual(collected.backups.length, 50, "the default source must cap the record list at 50");
  const failedRecord = collected.backups.find((record) => record.backupId === "bk-000");
  assert.strictEqual(failedRecord.verification.status, "failed", "verification.state must map into the evaluator's shape");
  assert.strictEqual(failedRecord.status, "complete", "the agent status is preserved");

  // A throwing read degrades to empty and never breaks the tick.
  const failing = await withStubbedServiceRouter(
    { listBackups: async () => { throw new Error("agent down"); } },
    async () => defaultBackupCollector()(),
  );
  assert.deepStrictEqual(failing.backups, [], "a failing default read must degrade to empty");

  // No effective node -> no read at all (never an unscoped agent call).
  const skippedCalls = [];
  await withStubbedServiceRouter(
    { listBackups: async (options) => { skippedCalls.push(options); return { backups: [] }; } },
    async () => { await createOperationalNotificationCollector({})(); },
  );
  assert.strictEqual(skippedCalls.length, 0, "no effective node means no default backup read");

  // End to end: a failed backup found through the default source notifies
  // exactly once per backupId.
  const file = storeFile("backup-default-source");
  const journal = createService(file);
  await withStubbedServiceRouter(
    { listBackups: async () => ({ backups: [backupRecord("bk-failed", { status: "failed" })] }) },
    async () => {
      at("2026-02-01T21:00:00.000Z");
      const first = await journal.evaluate({ collectState: defaultBackupCollector() });
      assert.strictEqual(first.events.length, 1, "the failed backup must notify");
      assert.strictEqual(first.events[0].category, "backup", "the failure is a backup event");
      assert.strictEqual(first.events[0].title, "Backup failed", "the backup title must match the contract");
      at("2026-02-01T21:01:00.000Z");
      const second = await journal.evaluate({ collectState: defaultBackupCollector() });
      assert.strictEqual(second.events.length, 0, "the same backupId must not re-notify");
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 12: canonical provider states (providerAdapterContract vocabulary).
// ---------------------------------------------------------------------------
// The collector feeds { providerId, displayName, availability, state, connected }
// from providerAdapterContract; the legacy lifecycle/health rows in phase 4
// still prove backward tolerance, and this phase pins the canonical mapping.
async function phaseCanonicalProviderStates() {
  const file = storeFile("canonical-providers");
  // No dedupe window: this phase exercises the state mapping, not suppression.
  const service = createService(file, { dedupeWindowMs: 0 });
  const providerRow = (providerId, displayName, state, connected) => ({
    nodeId: "node-cp",
    providerId,
    displayName,
    availability: "available",
    state,
    connected,
  });

  at("2026-02-01T22:00:00.000Z");
  const seeded = await service.evaluate({
    collectState: async () => ({
      providers: [
        // displayName must win over the legacy name in every message.
        { ...providerRow("playit", "Playit Direct", "running", true), name: "Legacy Playit" },
        // connected:true must outrank a stopped state when seeding (otherwise
        // the next observation would read as an unchanged "stopped").
        providerRow("edge", "Edge Tunnel", "stopped", true),
      ],
    }),
  });
  assert.strictEqual(seeded.events.length, 0, "canonical provider rows seed without events");

  at("2026-02-01T22:01:00.000Z");
  const degradedAndStopped = await service.evaluate({
    collectState: async () => ({
      providers: [
        providerRow("playit", "Playit Direct", "degraded", null),
        providerRow("edge", "Edge Tunnel", "stopped", null),
      ],
    }),
  });
  assert.strictEqual(degradedAndStopped.events.length, 2, "connected -> degraded and connected -> stopped must each emit exactly one event");
  const byKey = new Map(degradedAndStopped.events.map((event) => [event.dedupKey, event]));
  const degraded = byKey.get("provider:node-cp:playit");
  assert(degraded, "the canonical degraded provider must emit");
  assert.strictEqual(degraded.severity, "warning", "a canonical degraded state is a warning");
  assert.strictEqual(degraded.title, "Tunnel provider degraded", "the degraded title must match the contract");
  assert(degraded.message.includes("Playit Direct"), "the degraded message must use displayName");
  assert(!degraded.message.includes("Legacy Playit"), "displayName must win over the legacy name field");
  assert(degraded.technicalDetails.includes("rawState=degraded"), "the degraded detail must record the canonical raw state");
  const stopped = byKey.get("provider:node-cp:edge");
  assert(stopped, "a canonical stopped provider must emit on transition (connected:true precedence seeded it as connected)");
  assert.strictEqual(stopped.severity, "critical", "connected -> stopped is critical");
  assert.strictEqual(stopped.title, "Tunnel provider disconnected", "the disconnect title must match the contract");
  assert(stopped.message.includes("Edge Tunnel"), "the disconnect message must use displayName");
  assert(stopped.message.includes("state: stopped"), "the disconnect message must include the canonical state");

  at("2026-02-01T22:02:00.000Z");
  const recovered = await service.evaluate({
    collectState: async () => ({
      providers: [
        providerRow("playit", "Playit Direct", "running", null),
        providerRow("edge", "Edge Tunnel", "running", null),
      ],
    }),
  });
  assert.strictEqual(recovered.events.length, 2, "each canonical provider recovery must emit one info event");
  assert(recovered.events.every((event) => event.severity === "info"), "provider recoveries are info");
  assert(recovered.events.every((event) => event.title === "Tunnel provider connected"), "the recovery title must match the contract");

  // auth-required is a stopped provider: connected -> auth-required is the same
  // critical disconnect as connected -> stopped.
  at("2026-02-01T22:03:00.000Z");
  const authRequired = await service.evaluate({
    collectState: async () => ({
      providers: [providerRow("edge", "Edge Tunnel", "auth-required", null)],
    }),
  });
  assert.strictEqual(authRequired.events.length, 1, "connected -> auth-required must emit exactly one event");
  assert.strictEqual(authRequired.events[0].severity, "critical", "auth-required is a critical disconnect");
  assert.strictEqual(authRequired.events[0].title, "Tunnel provider disconnected", "auth-required must use the disconnect title");

  // connected:true is the top precedence even against a stopped state.
  at("2026-02-01T22:04:00.000Z");
  const playitStopped = await service.evaluate({
    collectState: async () => ({
      providers: [providerRow("playit", "Playit Direct", "stopped", null)],
    }),
  });
  assert.strictEqual(playitStopped.events.length, 1, "connected -> stopped must emit the critical disconnect");
  assert.strictEqual(playitStopped.events[0].title, "Tunnel provider disconnected", "the stopped provider must use the disconnect title");

  at("2026-02-01T22:05:00.000Z");
  const connectedWins = await service.evaluate({
    collectState: async () => ({
      providers: [providerRow("playit", "Playit Direct", "stopped", true)],
    }),
  });
  assert.strictEqual(connectedWins.events.length, 1, "connected:true over a stopped state must read as a transition to connected");
  assert.strictEqual(connectedWins.events[0].severity, "info", "connected:true outranks stopped: the state is connected again");
  assert.strictEqual(connectedWins.events[0].title, "Tunnel provider connected", "connected:true must read as connected");

  // A running provider whose transport is explicitly down is degraded, not
  // connected.
  at("2026-02-01T22:06:00.000Z");
  const transportDown = await service.evaluate({
    collectState: async () => ({
      providers: [providerRow("playit", "Playit Direct", "running", false)],
    }),
  });
  assert.strictEqual(transportDown.events.length, 1, "connected -> running/connected:false must emit one event");
  assert.strictEqual(transportDown.events[0].severity, "warning", "running with a down transport is degraded");
  assert.strictEqual(transportDown.events[0].title, "Tunnel provider degraded", "running + connected:false must use the degraded title");
}

async function main() {
  assert.deepStrictEqual(SEVERITIES, ["info", "warning", "critical"], "the severity vocabulary is frozen");
  assert.deepStrictEqual(CATEGORIES, ["agent", "service", "provider", "endpoint", "backup"], "the category vocabulary is frozen");
  assert.strictEqual(NOTIFICATION_EVENT_SCHEMA_VERSION, 1, "the store schema version is 1");

  await phaseTransitionLifecycle();
  await phaseFirstObservationSeeding();
  await phaseRestartPersistence();
  await phaseVariants();
  await phaseDedupeWindow();
  await phaseBoundsAndCursor();
  await phaseRedaction();
  await phaseSchedulerAndErrors();
  await phaseCollector();
  await phaseIdentifierFallbacks();
  await phaseBackupDefaultSource();
  await phaseCanonicalProviderStates();

  console.log("operational-notifications-smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
