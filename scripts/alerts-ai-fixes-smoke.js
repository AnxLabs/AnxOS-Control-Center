// Hermetic regression checks for the alerts / notifications / assistant fixes
// (one numbered check per finding):
//   1. Real instance records carry no nodeId, so both collectors must stamp the
//      node the list was read for; a Stop or Restart must not read as
//      "stopped unexpectedly".
//   2. A problem suppressed by the notification dedupe window is announced once
//      the window has passed, if the target is still in that state.
//   3. The alert snapshot carries disk usage (telemetry or Agent profile) and
//      the newest backup per existing server, so DISK_PRESSURE and BACKUP_AGE
//      can fire.
//   4. The assistant reports a named offline computer, and never swaps a named
//      computer for a server on another one.
//   5. A webhook response cut off mid-body settles the delivery, so later
//      alerts are still sent.
//   6. The assistant's join diagnosis uses the asked-about server's own
//      internet check, never another server's.
//   7. A failed instance or backup read, or switching the selected computer,
//      keeps a node's INSTANCE_DEGRADED / BACKUP_AGE alerts (and their
//      acknowledgement) instead of clearing and re-firing them.
//   8. A transient "Unknown" instance state is no observation, so it never
//      reads as "stopped unexpectedly" followed by "running again".
//   9. A newest backup that failed verification is not a usable recovery
//      point, so it cannot hide BACKUP_AGE.
//  10. A failed node-list read keeps the alerts that come from node rows
//      (BACKUP_AGE, NODE_OFFLINE, DISK_PRESSURE) and their acknowledgement.
//
// Every data root points at a temp folder before any module loads. The only
// network use is a loopback HTTP server on an ephemeral port that stands in for
// the webhook (check 5); no Agent, service or scheduled task is touched.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-alerts-ai-fixes-"));
for (const key of ["ANXHUB_CONFIG_DIR", "ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT", "AGENT_TEMP_DIR", "AGENT_LOG_DIR", "AGENT_NOTIFICATION_ROOT"]) {
  process.env[key] = path.join(base, key.toLowerCase());
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.AGENT_IDENTITY_PATH = path.join(base, "identity.json");
process.env.AGENT_URL = "http://127.0.0.1:9";
process.on("exit", () => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

const ROOT = path.join(__dirname, "..");
const alertService = require(path.join(ROOT, "src/services/alertService"));
const { createAlertStateCollector } = require(path.join(ROOT, "src/services/alertStateCollector"));
const notificationsModule = require(path.join(ROOT, "src/services/operationalNotificationService"));
const { resolveTarget } = require(path.join(ROOT, "src/shared/aiOperations/intent"));
const { createAssistant } = require(path.join(ROOT, "src/shared/aiOperations/assistant"));
const { createApprovalBroker } = require(path.join(ROOT, "src/shared/aiOperations/approvalBroker"));
const { createComputerService } = require(path.join(ROOT, "src/services/computerService"));
const { createAiOperationsService } = require(path.join(ROOT, "src/services/aiOperationsService"));

const HOST = "application-host";
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error && error.stack ? error.stack : error}`);
  }
}

function hostNodeService(nodes = [{ id: HOST, kind: "application-host", state: "online" }]) {
  return {
    APPLICATION_HOST_NODE_ID: HOST,
    getSelectedNodeId: () => HOST,
    listNodes: async () => ({ nodes }),
  };
}

function freshAlertEngine(label) {
  alertService.resetAlertService({ keepStore: false });
  alertService.resetInstanceSnapshot();
  alertService.configureAlertService({ storePath: path.join(base, `alerts-${label}.json`), persist: false });
}

// The real record shape, read back through the real instance core.
async function readRealInstanceRecord() {
  const directory = path.join(process.env.AGENT_INSTANCE_ROOT, "survival");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({
    id: "survival", name: "Survival", type: "minecraft-paper", state: "Failed", failureReason: "PROCESS_EXITED", pid: null, port: 25565,
  }, null, 2));
  const core = require(path.join(ROOT, "src/shared/instances/instanceServiceCore"));
  const listed = await core.listInstances();
  const record = (listed.instances || []).find((entry) => entry.id === "survival");
  assert(record, "the real instance core must list the test instance");
  return record;
}

function runningCopy(record) {
  return { ...record, state: "Running", processState: "Running", readinessState: "ready", healthState: "healthy", failureReason: null, crashed: false };
}

// ---------------------------------------------------------------------------
// 1. Instance alerts and service notifications on the real record shape.
// ---------------------------------------------------------------------------
async function checkInstanceNodeBinding() {
  const failed = await readRealInstanceRecord();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(failed, "nodeId"), false, "precondition: real records carry no nodeId");
  const running = runningCopy(failed);

  // (a) Alert engine through the production collector.
  freshAlertEngine("instance");
  let payload = { instances: [failed] };
  const alertCollector = createAlertStateCollector({
    nodeService: hostNodeService(),
    alertService,
    serviceRouter: { listInstances: async () => payload },
  });
  const outcome = await alertService.runAlertEvaluation({ collectState: alertCollector });
  const degraded = outcome.alerts.find((alert) => alert.condition === "INSTANCE_DEGRADED" && alert.target === `${HOST}/survival`);
  assert(degraded, `a crashed server must raise INSTANCE_DEGRADED for ${HOST}/survival (got ${JSON.stringify(outcome.alerts.map((alert) => [alert.condition, alert.target]))})`);
  assert.strictEqual(degraded.severity, "critical", "a crashed server is critical");

  // (b) Notification journal through the production collector.
  let clock = Date.parse("2026-11-14T10:00:00.000Z");
  const journal = (label) => notificationsModule.createOperationalNotificationService({ storePath: path.join(base, `notifications-${label}.json`), now: () => clock });
  const notificationCollector = notificationsModule.createOperationalNotificationCollector({
    nodeService: hostNodeService(),
    alertService,
    serviceRouter: { listInstances: async () => payload, listBackups: async () => ({ backups: [] }) },
  });
  async function walk(label, sequence) {
    const service = journal(label);
    const titles = [];
    for (const step of sequence) {
      payload = { instances: [step] };
      alertService.resetInstanceSnapshot();
      clock += 10 * 60 * 1000;
      const result = await service.evaluate({ collectState: notificationCollector });
      assert.strictEqual(result.ok, true, `${label}: evaluation must succeed`);
      titles.push(...result.events.map((event) => event.title));
    }
    return titles;
  }
  assert.deepStrictEqual(await walk("crash", [running, failed]), ["Service crashed"], "Running -> Failed on the real record must emit one 'Service crashed'");

  // (c) User actions are not failures.
  const withState = (state, extra = {}) => ({ ...running, state, processState: state, readinessState: state.toLowerCase(), healthState: "unknown", ...extra });
  assert.deepStrictEqual(
    await walk("restart", [running, withState("Restarting"), withState("Starting"), running]),
    [],
    "a Restart (Running -> Restarting -> Starting -> Running) must emit nothing",
  );
  assert.deepStrictEqual(
    await walk("user-stop", [running, withState("Stopping"), withState("Stopped", { failureReason: null })]),
    [],
    "a user Stop (failureReason null) must not read as 'stopped unexpectedly'",
  );
  assert.deepStrictEqual(
    await walk("stale-stop", [running, withState("Stopped", { failureReason: "STALE_PID" })]),
    ["Service stopped unexpectedly"],
    "a stop the record reports as a failure (failureReason set) still warns",
  );
}

// ---------------------------------------------------------------------------
// 2. Dedupe window: a suppressed outage is announced once the window passes.
// ---------------------------------------------------------------------------
async function checkDedupeWindowReplay() {
  let clock = Date.parse("2026-11-14T10:00:00.000Z");
  const minute = (value) => Date.parse("2026-11-14T10:00:00.000Z") + value * 60 * 1000;
  async function walk(label, steps) {
    const service = notificationsModule.createOperationalNotificationService({ storePath: path.join(base, `dedupe-${label}.json`), now: () => clock });
    const emitted = [];
    for (const [at, state] of steps) {
      clock = minute(at);
      const result = await service.evaluate({ collectState: async () => ({ nodes: [{ nodeId: "vps", name: "VPS", state }] }) });
      emitted.push(...result.events.map((event) => [at, event.title]));
    }
    return { service, emitted };
  }

  const outage = await walk("outage", [[0, "online"], [1, "offline"], [2, "online"], [3, "offline"], [5, "offline"], [10, "offline"], [13, "offline"], [15, "offline"]]);
  assert.deepStrictEqual(
    outage.emitted,
    [[1, "Machine disconnected"], [2, "Machine back online"], [13, "Machine disconnected"]],
    "an outage that starts inside the window and lasts past it must be announced once, at the first pass after the window",
  );
  const newest = outage.service.list({}).events[0];
  assert.strictEqual(newest.title, "Machine disconnected", "the journal must not end on 'Machine back online' while the machine is down");
  assert.strictEqual(newest.resolvedAt, null, "the late disconnect is an unresolved incident");
  assert.strictEqual(newest.severity, "critical", "the late disconnect keeps its severity");

  const flap = await walk("flap", [[0, "online"], [1, "offline"], [2, "online"], [3, "offline"], [4, "online"], [15, "online"], [30, "online"]]);
  assert.deepStrictEqual(
    flap.emitted,
    [[1, "Machine disconnected"], [2, "Machine back online"]],
    "a flap that recovers inside the window must stay silent",
  );
}

// ---------------------------------------------------------------------------
// 3. Disk pressure and backup age through the production collector.
// ---------------------------------------------------------------------------
async function checkDiskAndBackupAlerts() {
  const record = runningCopy(await readRealInstanceRecord());
  const nowIso = new Date().toISOString();
  const nodes = [
    // Shapes from nodeService.listNodes(): the application host keeps only a
    // placeholder storage record; a local Agent keeps disk on its profile; a
    // remote Agent has none.
    { id: HOST, kind: "application-host", state: "online", applicationHost: { storage: { status: "metrics-required" } } },
    { id: "node-local", kind: "agent", state: "online", profile: { storage: { percent: 91 } } },
    { id: "vps", kind: "agent", state: "online" },
  ];
  const telemetryService = {
    getTelemetrySummary: () => ({
      series: [
        { key: `host:${HOST}:diskPercent`, kind: "host", nodeId: HOST, summary: { latestValue: 97, latestAt: nowIso } },
        { key: `host:${HOST}:cpuPercent`, kind: "host", nodeId: HOST, summary: { latestValue: 99, latestAt: nowIso } },
      ],
    }),
  };
  let backups = [];
  const collector = createAlertStateCollector({
    nodeService: hostNodeService(nodes),
    alertService,
    serviceRouter: {
      listInstances: async () => ({ instances: [record] }),
      // serviceRouter.listBackups stamps nodeId on every row (withNodeContext).
      listBackups: async ({ nodeId }) => ({ nodeId, backups: backups.map((row) => ({ ...row, nodeId })) }),
    },
    telemetryService,
  });
  const agentBackup = (id, instanceId, backupAgeDays) => ({ id, instanceId, status: "complete", backupAgeDays, retentionPolicy: { keepLast: 10, maxAgeDays: 30, source: "default" } });

  freshAlertEngine("disk-newest");
  backups = [agentBackup("old", "survival", 45), agentBackup("new", "survival", 2), agentBackup("gone", "deleted-server", 60)];
  let outcome = await alertService.runAlertEvaluation({ collectState: collector });
  let pairs = outcome.alerts.map((alert) => [alert.condition, alert.target, alert.severity]);
  assert(pairs.some(([condition, target, severity]) => condition === "DISK_PRESSURE" && target === HOST && severity === "critical"), `the host's 97% disk reading must raise DISK_PRESSURE critical (got ${JSON.stringify(pairs)})`);
  assert(pairs.some(([condition, target, severity]) => condition === "DISK_PRESSURE" && target === "node-local" && severity === "warning"), `a local Agent's 91% profile reading must raise DISK_PRESSURE warning (got ${JSON.stringify(pairs)})`);
  assert(!pairs.some(([condition, target]) => condition === "DISK_PRESSURE" && target === "vps"), "a computer with no disk reading raises no disk alert");
  assert(!pairs.some(([condition]) => condition === "BACKUP_AGE"), `the newest backup is 2 days old, and a deleted server's archives never alert (got ${JSON.stringify(pairs)})`);

  freshAlertEngine("backup-stale");
  backups = [agentBackup("old", "survival", 45)];
  outcome = await alertService.runAlertEvaluation({ collectState: collector });
  pairs = outcome.alerts.map((alert) => [alert.condition, alert.target, alert.severity]);
  assert(pairs.some(([condition, target, severity]) => condition === "BACKUP_AGE" && target === `${HOST}/survival` && severity === "warning"), `a 45-day-old newest backup must raise BACKUP_AGE (got ${JSON.stringify(pairs)})`);
}

// ---------------------------------------------------------------------------
// 4. Assistant targeting with a named computer.
// ---------------------------------------------------------------------------
async function checkNamedComputerTargeting() {
  const thisPc = { id: HOST, name: "This PC", online: true };
  const survival = { id: "survival", nodeId: HOST, name: "Survival", game: "minecraft-paper", state: "running" };
  const weekend = { id: "weekend", nodeId: "vps-7360e3ad", name: "Weekend", game: "palworld", state: "running" };
  const question = "restart the minecraft server on vps";

  const offline = resolveTarget(question, "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: false }], servers: [survival] }, { requireExplicit: true });
  assert.strictEqual(offline.status, "offline", `a named offline computer must be reported (got ${JSON.stringify(offline)})`);
  assert.strictEqual(offline.label, "VPS");
  assert.deepStrictEqual(offline.target, { nodeId: "vps-7360e3ad" });

  const wrongGame = resolveTarget(question, "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: true }], servers: [survival, weekend] }, { requireExplicit: true });
  assert.strictEqual(wrongGame.status, "none", `a named game with no server on the named computer must not pick another server (got ${JSON.stringify(wrongGame)})`);
  assert.match(wrongGame.message, /VPS/);

  const wrongComputer = resolveTarget("restart survival on vps", "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: true }], servers: [survival] }, { requireExplicit: true });
  assert.strictEqual(wrongComputer.status, "none", `a named server on another computer must not be swapped in (got ${JSON.stringify(wrongComputer)})`);

  const diagnose = resolveTarget("why is the minecraft server on vps crashing", "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: false }], servers: [survival] }, {});
  assert.strictEqual(diagnose.status, "offline", "the diagnose path also reports the named offline computer");

  // Positive controls: the named computer still narrows to its own servers.
  const onlyServer = resolveTarget("restart the server on vps", "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: true }], servers: [survival, weekend] }, { requireExplicit: true });
  assert.strictEqual(onlyServer.status, "resolved", `the named computer's only server is taken when nothing rules it out (got ${JSON.stringify(onlyServer)})`);
  assert.deepStrictEqual(onlyServer.target, { nodeId: "vps-7360e3ad", instanceId: "weekend" });
  const matchingGame = resolveTarget("restart the palworld server on vps", "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: true }], servers: [survival, weekend] }, { requireExplicit: true });
  assert.deepStrictEqual(matchingGame.target, { nodeId: "vps-7360e3ad", instanceId: "weekend" });
  const unnamed = resolveTarget("restart the minecraft server", "instance", { computers: [thisPc, { id: "vps-7360e3ad", name: "VPS", online: true }], servers: [survival, weekend] }, { requireExplicit: true });
  assert.deepStrictEqual(unnamed.target, { nodeId: HOST, instanceId: "survival" }, "without a named computer the game still finds the server");

  // End to end: no proposal, and the answer says VPS is not connected.
  const computers = [thisPc, { id: "vps-7360e3ad", name: "VPS", online: false }];
  const executeReadTool = async (call) => {
    const id = call.definition.id;
    if (id === "computers.list") return { data: { computers }, observations: [] };
    if (id === "servers.list") return { data: { servers: call.target.nodeId === HOST ? [survival] : [] }, observations: [] };
    if (id === "server.status") return { data: { server: { players: { online: 3 } } }, observations: [] };
    throw new Error(`unexpected read ${id}`);
  };
  const assistant = createAssistant({ executeReadTool, broker: createApprovalBroker(), provider: null });
  const response = await assistant.ask({ question: "Restart the minecraft server on vps", actor: { id: "u", username: "owner", role: "Owner" } });
  assert.strictEqual(response.proposal, null, `no proposal may be created for a server on another computer (got ${JSON.stringify(response.proposal && response.proposal.preview)})`);
  assert.match(response.answer, /VPS is not connected/);
  assert(response.missing.some((note) => /VPS is not connected/.test(note)), `the inventory's missing notes reach the answer (got ${JSON.stringify(response.missing)})`);
}

// ---------------------------------------------------------------------------
// 5. Agent webhook: a response cut off mid-body settles the delivery.
// ---------------------------------------------------------------------------
async function checkWebhookTruncatedResponse() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    if (requests === 1) {
      response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
      response.write("0123456789");
      setTimeout(() => response.socket.destroy(), 50);
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const originalRequest = https.request;
  // The module calls https.request at send time; route it to the loopback
  // stand-in so the real request/response event handling runs.
  https.request = (url, options, callback) => http.request({ host: "127.0.0.1", port, path: "/hook", method: options.method, headers: options.headers, timeout: options.timeout }, callback);
  try {
    const notifications = require(path.join(ROOT, "agent/src/services/notificationService"));
    const root = path.join(base, "agent-notifications");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "webhook.json"), JSON.stringify({ schemaVersion: 1, url: "https://hook.example.test/x", enabled: true, events: ["instance.crashed", "update.failed"] }));
    notifications.configureNotificationService({ root, reset: true, transport: null });
    notifications.notify("instance.crashed", { instanceId: "a" });
    notifications.notify("update.failed", { instanceId: "b" });
    let timer = null;
    const outcome = await Promise.race([
      notifications.flushNotifications().then(() => "settled"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("pending"), 2500); }),
    ]);
    clearTimeout(timer);
    assert.strictEqual(outcome, "settled", "a cut-off response must settle well before the 5 s delivery timeout");
    assert.strictEqual(requests, 2, "the alert queued behind the cut-off one must still be sent");
    const settings = await notifications.getNotificationSettings();
    assert.strictEqual(settings.lastDelivery && settings.lastDelivery.event, "update.failed");
    assert.strictEqual(settings.lastDelivery.ok, true);
  } finally {
    https.request = originalRequest;
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 6. Join diagnosis uses the asked-about server's own reachability.
// ---------------------------------------------------------------------------
async function checkJoinDiagnosisReachability() {
  const instances = [
    { id: "minecraft", displayName: "Minecraft", game: "minecraft", status: "running" },
    { id: "palworld", displayName: "Palworld", game: "palworld", status: "running" },
  ];
  const diagnostics = (publicState) => ({ cached: true, reachability: { local: "healthy", lan: "healthy", private_overlay: "not_configured", public: publicState } });
  async function ask(cachedByService) {
    const getCachedDiagnostics = async ({ serviceId }) => (cachedByService[serviceId] ? diagnostics(cachedByService[serviceId]) : { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" });
    const computers = createComputerService({ deps: {
      listNodes: async () => [{ id: HOST, kind: "application-host", displayName: "This PC", state: "online" }],
      getNode: async () => ({ id: HOST, kind: "application-host", displayName: "This PC", state: "online", connectionState: "online", lastSeenAt: new Date().toISOString() }),
      listEndpoints: async () => [],
      getEndpointSummary: async () => ({}),
      getProviderSyncs: async () => ({}),
      getCachedProviderSnapshot: async () => null,
      getTelemetrySummary: async () => ({ series: [] }),
      getCachedDiagnostics,
      listInstances: async () => instances,
    } });
    const user = { id: "u1", username: "owner", role: "Owner" };
    const ai = createAiOperationsService({
      readSettings: () => ({ "ai.enabled": true, "ai.provider": "deterministic", "ai.allowRemoteProvider": false }),
      requirePermission: () => user,
      audit: () => {},
      getCurrentUser: () => user,
      configDir: null,
      services: {
        listComputerSummaries: () => computers.listComputerSummaries(),
        getCachedDiagnostics,
        listInstances: async () => instances,
        getInstanceStatus: async (id) => ({ instance: instances.find((entry) => entry.id === id) }),
        getInstanceLogs: async () => ({ entries: [] }),
        getInstancePlayers: async () => ({ online: 0, max: 20 }),
        getSystemSnapshot: async () => ({}),
        anxnetStatus: async () => ({ running: false }),
        listDockerContainers: async () => [],
        runInScope: async (_prefix, operation) => operation(),
        listLocalRunningServers: async () => 0,
      },
    });
    return ai.ask({ question: "why can't my friends join minecraft?" });
  }
  const codes = (response) => (response.findings || []).map((finding) => finding.code);

  const otherFailed = await ask({ minecraft: "healthy", palworld: "failed" });
  assert.strictEqual(otherFailed.target && otherFailed.target.instanceId, "minecraft", "precondition: the question targets Minecraft");
  assert(!codes(otherFailed).includes("PUBLIC_UNREACHABLE"), `Palworld's failed check must not be reported as Minecraft's (got ${JSON.stringify(codes(otherFailed))})`);

  const unchecked = await ask({ palworld: "healthy" });
  assert(unchecked.missing.some((note) => /Internet reachability was not measured/.test(note)), `Minecraft was never checked, so the answer must say so (got ${JSON.stringify(unchecked.missing)})`);

  const ownFailed = await ask({ minecraft: "failed", palworld: "healthy" });
  assert(codes(ownFailed).includes("PUBLIC_UNREACHABLE"), `Minecraft's own failed check is reported (got ${JSON.stringify(codes(ownFailed))})`);
}

// ---------------------------------------------------------------------------
// 7. Unobserved nodes keep their node-scoped alerts and acknowledgements.
// ---------------------------------------------------------------------------
async function checkUnobservedNodeAlertsKept() {
  const failed = await readRealInstanceRecord();
  const running = runningCopy(failed);
  let selected = "node-a";
  let nodes = [{ id: "node-a", kind: "agent", state: "online" }, { id: "node-b", kind: "agent", state: "online" }];
  let instancesByNode = { "node-a": [failed], "node-b": [running] };
  let backupsByNode = { "node-a": [{ id: "a-old", instanceId: "survival", status: "complete", backupAgeDays: 40, retentionPolicy: { maxAgeDays: 7 } }], "node-b": [] };
  let instanceRead = "ok";
  let backupRead = "ok";
  const collector = createAlertStateCollector({
    nodeService: { APPLICATION_HOST_NODE_ID: HOST, getSelectedNodeId: () => selected, listNodes: async () => ({ nodes }) },
    alertService,
    serviceRouter: {
      // Production listInstances({}) reads the selected computer implicitly.
      listInstances: async () => {
        if (instanceRead === "fail") throw Object.assign(new Error("Agent unavailable"), { code: "AGENT_UNAVAILABLE" });
        return { instances: instancesByNode[selected] || [] };
      },
      listBackups: async ({ nodeId }) => {
        if (backupRead === "fail") throw Object.assign(new Error("Backup list failed"), { code: "BACKUP_LIST_FAILED" });
        return { nodeId, backups: (backupsByNode[nodeId] || []).map((row) => ({ ...row, nodeId })) };
      },
    },
  });
  const targets = ["BACKUP_AGE", "INSTANCE_DEGRADED"];
  const pass = async () => {
    alertService.resetInstanceSnapshot();
    const outcome = await alertService.runAlertEvaluation({ collectState: collector });
    assert.strictEqual(outcome.ok, true);
    return outcome;
  };
  const nodeA = (outcome) => outcome.alerts
    .filter((alert) => targets.includes(alert.condition) && alert.target === "node-a/survival")
    .map((alert) => [alert.condition, alert.acknowledgedAt !== null, alert.firstSeenAt])
    .sort();
  const recovered = (outcome) => outcome.transitions.filter((transition) => transition.type === "RECOVERED").map((transition) => transition.alertId);

  freshAlertEngine("unobserved");
  let outcome = await pass();
  const fired = nodeA(outcome);
  assert.deepStrictEqual(fired.map(([condition]) => condition), targets, `precondition: both node-a alerts fire (got ${JSON.stringify(fired)})`);
  for (const alert of outcome.alerts) alertService.acknowledgeAlert({ id: alert.id, actor: "owner" });
  const acknowledged = fired.map(([condition, , firstSeenAt]) => [condition, true, firstSeenAt]);

  for (const [label, setup] of [
    ["backup read fails", () => { backupRead = "fail"; }],
    ["instance read fails", () => { backupRead = "ok"; instanceRead = "fail"; }],
    ["another computer is selected", () => { instanceRead = "ok"; selected = "node-b"; }],
    ["node-a is selected again", () => { selected = "node-a"; }],
  ]) {
    setup();
    outcome = await pass();
    assert.deepStrictEqual(recovered(outcome), [], `${label}: no node-a alert may recover (got ${JSON.stringify(recovered(outcome))})`);
    assert.deepStrictEqual(nodeA(outcome), acknowledged, `${label}: node-a's alerts stay active with their acknowledgement and first-seen time`);
  }

  // Positive controls: a real observation still clears them, and a computer
  // that is no longer listed does not keep its alerts forever.
  instancesByNode = { ...instancesByNode, "node-a": [running] };
  backupsByNode = { ...backupsByNode, "node-a": [{ id: "a-new", instanceId: "survival", status: "complete", backupAgeDays: 1, retentionPolicy: { maxAgeDays: 7 } }] };
  outcome = await pass();
  assert.deepStrictEqual(recovered(outcome).sort(), ["alert:BACKUP_AGE:node-a/survival", "alert:INSTANCE_DEGRADED:node-a/survival"], `an observed healthy server with a fresh backup clears both alerts (got ${JSON.stringify(recovered(outcome))})`);

  freshAlertEngine("unobserved-removed");
  instancesByNode = { ...instancesByNode, "node-a": [failed] };
  backupsByNode = { ...backupsByNode, "node-a": [{ id: "a-old", instanceId: "survival", status: "complete", backupAgeDays: 40, retentionPolicy: { maxAgeDays: 7 } }] };
  outcome = await pass();
  assert.strictEqual(nodeA(outcome).length, 2, "precondition: both node-a alerts fire again");
  selected = "node-b";
  nodes = [{ id: "node-b", kind: "agent", state: "online" }];
  outcome = await pass();
  assert.deepStrictEqual(nodeA(outcome), [], "a computer removed from the node list does not keep its server alerts");
}

// ---------------------------------------------------------------------------
// 8. A transient Unknown instance state is not a stop.
// ---------------------------------------------------------------------------
async function checkUnknownInstanceStateIsNoObservation() {
  const running = runningCopy(await readRealInstanceRecord());
  let clock = Date.parse("2026-11-14T12:00:00.000Z");
  let payload = { instances: [running] };
  const collector = notificationsModule.createOperationalNotificationCollector({
    nodeService: hostNodeService(),
    alertService,
    serviceRouter: { listInstances: async () => payload, listBackups: async () => ({ backups: [] }) },
  });
  async function walk(label, sequence) {
    const service = notificationsModule.createOperationalNotificationService({ storePath: path.join(base, `unknown-${label}.json`), now: () => clock });
    const titles = [];
    for (const step of sequence) {
      payload = { instances: [step] };
      alertService.resetInstanceSnapshot();
      clock += 10 * 60 * 1000;
      const result = await service.evaluate({ collectState: collector });
      assert.strictEqual(result.ok, true, `${label}: evaluation must succeed`);
      titles.push(...result.events.map((event) => event.title));
    }
    return titles;
  }
  const unknown = (failureReason) => ({ ...running, state: "Unknown", processState: "Unknown", readinessState: "unknown", healthState: "unknown", failureReason });
  for (const reason of ["SERVICE_QUERY_FAILED", "RUNTIME_PROBE_INCONCLUSIVE"]) {
    assert.deepStrictEqual(await walk(reason, [running, unknown(reason), running]), [], `Running -> Unknown/${reason} -> Running must emit nothing`);
  }
  assert.deepStrictEqual(
    await walk("empty", [running, { ...running, state: "", processState: "", readinessState: "", healthState: "" }, running]),
    [],
    "a record with no state is no observation either",
  );
  // Positive control: the last known Running state is kept across Unknown, so
  // a real failure afterwards is still reported.
  assert.deepStrictEqual(
    await walk("unknown-then-stale", [running, unknown("SERVICE_QUERY_FAILED"), { ...running, state: "Stopped", processState: "Stopped", failureReason: "STALE_PID" }]),
    ["Service stopped unexpectedly"],
    "a definite failed stop after an Unknown pass still warns",
  );
}

// ---------------------------------------------------------------------------
// 9. A backup that failed verification does not count as the newest backup.
// ---------------------------------------------------------------------------
async function checkFailedVerificationBackupIgnored() {
  const record = runningCopy(await readRealInstanceRecord());
  let backups = [];
  const collector = createAlertStateCollector({
    nodeService: hostNodeService(),
    alertService,
    serviceRouter: {
      listInstances: async () => ({ instances: [record] }),
      listBackups: async ({ nodeId }) => ({ nodeId, backups: backups.map((row) => ({ ...row, nodeId })) }),
    },
  });
  // Agent record shape: status stays "complete"; verifyBackup stores its
  // result in verification.state (verified / failed / corrupt / unknown).
  const agentBackup = (id, backupAgeDays, verification) => ({ id, instanceId: "survival", status: "complete", backupAgeDays, retentionPolicy: { keepLast: 10, maxAgeDays: 7, source: "default" }, verification });
  const backupAge = async (label, rows) => {
    freshAlertEngine(`verification-${label}`);
    backups = rows;
    const outcome = await alertService.runAlertEvaluation({ collectState: collector });
    return outcome.alerts.some((alert) => alert.condition === "BACKUP_AGE" && alert.target === `${HOST}/survival`);
  };
  const verified = { state: "verified", method: "sha256" };
  const old = agentBackup("old", 30, verified);
  assert.strictEqual(await backupAge("failed", [agentBackup("new", 0.5, { state: "failed", code: "BACKUP_ARCHIVE_LIMIT_EXCEEDED" }), old]), true, "a newest backup that failed verification must not hide a 30-day-old usable one");
  assert.strictEqual(await backupAge("corrupt", [agentBackup("new", 0.5, { state: "corrupt" }), old]), true, "a corrupt newest backup must not hide BACKUP_AGE");
  // Controls: a verified or never-verified (unknown) newest backup counts.
  assert.strictEqual(await backupAge("verified", [agentBackup("new", 0.5, verified), old]), false, "a verified fresh backup is the newest usable one");
  assert.strictEqual(await backupAge("unknown", [agentBackup("new", 0.5, { state: "unknown" }), old]), false, "a fresh backup whose verification could not be evaluated still counts");
  assert.strictEqual(await backupAge("none", [agentBackup("new", 0.5, undefined), old]), false, "a fresh backup that was never verified still counts");
}

// ---------------------------------------------------------------------------
// 10. A failed node list is no observation of the node-row alerts.
// ---------------------------------------------------------------------------
async function checkFailedNodeListKeepsAlerts() {
  const record = runningCopy(await readRealInstanceRecord());
  let nodes = [
    { id: "node-a", kind: "agent", state: "online", profile: { storage: { percent: 96 } } },
    { id: "node-b", kind: "agent", state: "offline" },
  ];
  let nodeRead = "ok";
  const collector = createAlertStateCollector({
    nodeService: {
      APPLICATION_HOST_NODE_ID: HOST,
      getSelectedNodeId: () => "node-a",
      // nodeService.listNodes throws NODE_CONFIG_CORRUPT on an unreadable nodes.json.
      listNodes: async () => {
        if (nodeRead === "fail") throw Object.assign(new Error("nodes.json unreadable"), { code: "NODE_CONFIG_CORRUPT" });
        return { nodes };
      },
    },
    alertService,
    serviceRouter: {
      listInstances: async () => ({ instances: [record] }),
      listBackups: async ({ nodeId }) => ({ nodeId, backups: [{ id: "a-old", instanceId: "survival", status: "complete", backupAgeDays: 40, retentionPolicy: { maxAgeDays: 7 }, nodeId }] }),
    },
  });
  const pass = async () => {
    alertService.resetInstanceSnapshot();
    const outcome = await alertService.runAlertEvaluation({ collectState: collector });
    assert.strictEqual(outcome.ok, true);
    return outcome;
  };
  const summary = (outcome) => outcome.alerts.map((alert) => [alert.id, alert.acknowledgedAt !== null, alert.firstSeenAt]).sort();
  const transitions = (outcome, type) => outcome.transitions.filter((transition) => transition.type === type).map((transition) => transition.alertId).sort();
  const expected = ["alert:BACKUP_AGE:node-a/survival", "alert:DISK_PRESSURE:node-a", "alert:NODE_OFFLINE:node-b"];

  freshAlertEngine("nodes-fail");
  let outcome = await pass();
  assert.deepStrictEqual(outcome.alerts.map((alert) => alert.id).sort(), expected, `precondition: the node-row alerts fire (got ${JSON.stringify(summary(outcome))})`);
  for (const alert of outcome.alerts) alertService.acknowledgeAlert({ id: alert.id, actor: "owner" });
  const acknowledged = summary(await pass());
  assert(acknowledged.every(([, isAcknowledged]) => isAcknowledged), "precondition: every alert is acknowledged");

  for (const [label, read] of [["the node list fails", "fail"], ["the node list fails again", "fail"], ["the node list loads again", "ok"]]) {
    nodeRead = read;
    outcome = await pass();
    assert.deepStrictEqual(transitions(outcome, "RECOVERED"), [], `${label}: no node-row alert may recover (got ${JSON.stringify(transitions(outcome, "RECOVERED"))})`);
    assert.deepStrictEqual(transitions(outcome, "FIRED"), [], `${label}: nothing may fire again (got ${JSON.stringify(transitions(outcome, "FIRED"))})`);
    assert.deepStrictEqual(summary(outcome), acknowledged, `${label}: the alerts keep their acknowledgement and first-seen time`);
  }

  // Positive controls: a node list that loads still recovers what it shows
  // healthy, and a computer missing from it does not keep its alerts.
  nodes = [{ id: "node-a", kind: "agent", state: "online", profile: { storage: { percent: 40 } } }];
  outcome = await pass();
  assert.deepStrictEqual(transitions(outcome, "RECOVERED"), ["alert:DISK_PRESSURE:node-a", "alert:NODE_OFFLINE:node-b"], `a loaded node list recovers a healthy disk and a removed computer (got ${JSON.stringify(transitions(outcome, "RECOVERED"))})`);
  assert.deepStrictEqual(outcome.alerts.map((alert) => alert.id), ["alert:BACKUP_AGE:node-a/survival"], "the still-stale backup stays active");
}

(async () => {
  await check("1. ai-alerts-telemetry-1: instance alerts and service notifications fire on the real record shape; Stop/Restart stay silent", checkInstanceNodeBinding);
  await check("2. ai-alerts-telemetry-2: an outage suppressed by the dedupe window is announced once the window passes", checkDedupeWindowReplay);
  await check("3. ai-alerts-telemetry-3: disk pressure and newest-backup age reach the alert evaluator", checkDiskAndBackupAlerts);
  await check("4. ai-alerts-telemetry-4: a named computer is reported offline or kept, never swapped", checkNamedComputerTargeting);
  await check("5. ai-alerts-telemetry-5: a webhook response cut off mid-body does not block later alerts", checkWebhookTruncatedResponse);
  await check("6. ai-alerts-telemetry-6: join diagnosis uses the server's own internet check", checkJoinDiagnosisReachability);
  await check("7. R17: a failed read or a computer switch keeps node-scoped alerts and their acknowledgement", checkUnobservedNodeAlertsKept);
  await check("8. R18: a transient Unknown instance state never reads as a stop and a recovery", checkUnknownInstanceStateIsNoObservation);
  await check("9. R19: a newest backup that failed verification cannot hide BACKUP_AGE", checkFailedVerificationBackupIgnored);
  await check("10. Q7: a failed node list keeps BACKUP_AGE, NODE_OFFLINE and DISK_PRESSURE and their acknowledgement", checkFailedNodeListKeepsAlerts);
  const failed = results.filter((result) => !result.ok);
  console.log(`alerts-ai-fixes-smoke: ${results.length - failed.length}/${results.length} passed (${results.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
