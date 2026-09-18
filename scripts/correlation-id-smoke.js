// V2-J bullet 2 hermetic smoke: correlate user operations -> backend jobs ->
// Agent actions -> workload logs through stable ids.
//
// Pins, without network, electron or a spawned process:
//   1. a correlation id is minted per operation scope and is stable within it
//      (including across awaits), and nested scopes inherit the parent id;
//   2. the canonical field name is `correlationId` and the module header that
//      documents it is present (no fourth id concept is introduced);
//   3. the id reaches a durable job record (real `jobLifecycle` engine with an
//      injected audit sink), an Agent action audit line (real
//      `agent/src/audit/auditLogger.js` + console sink) and a workload/instance
//      log line (real `instanceServiceCore` appendLog/readRecentLines pair,
//      which is the same reader the Agent `/logs` route path uses);
//   4. ids are opaque, never derive from caller input (path/token-shaped input
//      is rejected), and no seeded secret appears in any emitted line;
//   5. nothing changes when no scope is active.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-correlation-"));
// Pinned before any module that resolves its log/instance roots at require time.
process.env.ANXOS_LOG_DIR = path.join(temp, "logs");
process.env.ANXHUB_CONFIG_DIR = path.join(temp, "desktop-config");
process.env.AGENT_INSTANCE_ROOT = path.join(temp, "instances");

const structuredLogger = require("../src/shared/structuredLogger");
const {
  CORRELATION_ID_FIELD,
  StructuredLogger,
  correlationFields,
  correlationMetadata,
  createCorrelationId,
  currentCorrelation,
  currentCorrelationId,
  isCorrelationId,
  runWithCorrelationScope,
  withOperationScope,
} = structuredLogger;
const agentDiagnostics = require("../agent/src/services/diagnosticsLogger");
const { auditAction } = require("../agent/src/audit/auditLogger");
const engine = require("../src/shared/instances/jobLifecycle");
const core = require("../src/shared/instances/instanceServiceCore");
const desktopDiagnostics = require("../src/services/diagnosticsService");

// `<prefix>-<uuid>`: lowercase prefix plus a fixed-length UUID. Every id that
// reaches an emitted artifact must match this.
const OPAQUE_ID = /^[a-z][a-z0-9-]{0,23}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_JOIN_KEY = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SEEDED_SECRETS = [
  "corr-smoke-super-secret",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.abcdefghijklmnopqrstuvwxyz123456",
  "agent-token-secret",
];

const jobsRoot = path.join(temp, "jobs");
engine.configureJobLifecycle({ getRoot: () => jobsRoot });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  console.log("Checking the correlation context primitive...");
  assert.strictEqual(CORRELATION_ID_FIELD, "correlationId", "The canonical correlation field must be `correlationId`.");
  const loggerSource = fs.readFileSync(path.join(root, "src", "shared", "structuredLogger.js"), "utf8");
  assert(loggerSource.includes("Canonical field name: `correlationId`"), "The shared logger header must document the canonical field name.");
  assert(loggerSource.includes("`jobId`") && loggerSource.includes("`operationId`"), "The primitive must document that it reuses the existing jobId/operationId ids.");

  assert.strictEqual(currentCorrelationId(), null, "No correlation id exists outside a scope.");
  assert.deepStrictEqual(correlationFields(), {}, "An inactive scope contributes no fields.");
  assert.deepStrictEqual(correlationMetadata(), {}, "An inactive scope contributes no metadata.");
  assert.strictEqual(isCorrelationId("user-supplied"), false, "Arbitrary caller strings are not correlation ids.");
  assert.strictEqual(isCorrelationId("/home/private-user/AnxOS/agent.json"), false, "A path is not a correlation id.");
  assert.strictEqual(isCorrelationId(createCorrelationId()), true, "A minted id is a correlation id.");

  const scopeLogDir = path.join(temp, "scope-logs");
  const logger = new StructuredLogger({ directory: scopeLogDir, source: "correlation", processName: "smoke" });

  const observed = await withOperationScope("user-operation", async () => {
    const first = currentCorrelationId();
    assert(OPAQUE_ID.test(first), `Operation scope ids must be opaque (got ${first}).`);
    await wait(15);
    assert.strictEqual(currentCorrelationId(), first, "A scope id is stable across awaits within the scope.");
    const scopedLine = logger.info("operation", "Inside the operation scope", { accessToken: SEEDED_SECRETS[2] });
    assert.strictEqual(scopedLine.correlationId, first, "Structured log lines inside a scope carry the scope id.");
    assert.strictEqual(scopedLine.context.accessToken, "[redacted]", "Scope logging still redacts secrets.");
    const nested = withOperationScope("nested-step", () => ({ id: currentCorrelationId(), scope: currentCorrelation() }));
    assert.strictEqual(nested.id, first, "A nested scope inherits the parent operation id.");
    assert.strictEqual(nested.scope.inherited, true, "The nested scope reports that it inherited its id.");
    assert.strictEqual(nested.scope.parentId, first, "The nested scope keeps the parent id as its parent key.");
    assert.strictEqual(nested.scope.depth, 1, "The nested scope records its depth.");
    // Explicit join keys reuse the existing job/operation ids unchanged.
    const joins = runWithCorrelationScope({ prefix: "job-step", jobId: `job_${"a".repeat(32)}`, operationId: "steamcmd-update-1-abc" }, () => correlationFields());
    assert.strictEqual(joins.correlationId, first, "Join-key scopes stay on the same operation id.");
    assert.strictEqual(joins.jobId, `job_${"a".repeat(32)}`, "The durable job id is carried as the existing `jobId` field.");
    assert.strictEqual(joins.operationId, "steamcmd-update-1-abc", "The long-operation id is carried as the existing `operationId` field.");
    return {
      id: first,
      branch: runWithCorrelationScope({ prefix: "explicit", correlationId: createCorrelationId("explicit") }, () => currentCorrelation()),
    };
  });
  assert.strictEqual(currentCorrelationId(), null, "The scope must be left when its callback settles.");
  assert.notStrictEqual(observed.branch.id, observed.id, "An explicitly supplied opaque id starts a new root scope.");
  assert.strictEqual(observed.branch.parentId, observed.id, "The branching scope still records the operation it branched from.");

  // Ambient logging after a scope has closed must be unchanged (no behavior change when unused).
  const uncorrelated = logger.info("operation", "Outside any scope");
  assert.strictEqual(uncorrelated.correlationId, null, "Log lines outside a scope keep a null correlation id.");
  const explicitWins = logger.info("operation", "Explicit id wins", {}, { correlationId: observed.id });
  assert.strictEqual(explicitWins.correlationId, observed.id, "An explicit correlationId option still takes precedence.");

  console.log("Checking id opacity against caller input...");
  assert(createCorrelationId("agent-control").startsWith("agent-control-"), "A conforming operation label is used verbatim as the id prefix.");
  const injected = createCorrelationId("../../etc/passwd?token=corr-smoke-super-secret");
  assert(OPAQUE_ID.test(injected), `A caller-supplied prefix must not be able to break the id shape (got ${injected}).`);
  assert(injected.startsWith("corr-"), `A non-conforming label must fall back to the neutral prefix (got ${injected}).`);
  for (const forbidden of ["/", "\\", "?", "=", ":", " ", "passwd", "etc"]) {
    assert(!injected.includes(forbidden), `A correlation id must never contain ${JSON.stringify(forbidden)}.`);
  }
  assert(!injected.includes(SEEDED_SECRETS[0]), "A correlation id must never contain a full secret.");
  const uppercaseLabel = createCorrelationId("Instances:Start");
  assert(OPAQUE_ID.test(uppercaseLabel) && !uppercaseLabel.includes("Instances"), "A mixed-case/separated label must not be normalized into the id.");
  const guarded = withOperationScope("guard", () => ({
    id: currentCorrelationId(),
    fromPath: correlationMetadata("/home/private-user/AnxOS/agent.json?token=corr-smoke-super-secret"),
  }));
  assert.strictEqual(guarded.fromPath.correlationId, guarded.id, "A path/token-shaped id must be rejected in favour of the ambient scope id.");
  assert(!JSON.stringify(guarded.fromPath).includes("agent.json"), "A rejected id must not leak into the metadata it was passed for.");

  console.log("Checking desktop diagnostics integration...");
  assert.strictEqual(typeof desktopDiagnostics.withOperationScope, "function", "diagnosticsService must expose the operation scope primitive.");
  assert.strictEqual(typeof desktopDiagnostics.currentCorrelationId, "function", "diagnosticsService must expose the ambient id reader.");
  const diagnosticId = desktopDiagnostics.correlationId("diag");
  assert(OPAQUE_ID.test(diagnosticId) && diagnosticId.startsWith("diag-"), `diagnosticsService.correlationId must stay a <prefix>-<uuid> id (got ${diagnosticId}).`);
  assert.strictEqual(desktopDiagnostics.createCorrelationId, structuredLogger.createCorrelationId, "diagnosticsService must reuse the shared generator, not a second one.");
  const desktopScoped = await desktopDiagnostics.withOperationScope("desktop-ipc-op", async () => {
    const id = desktopDiagnostics.currentCorrelationId();
    const entry = desktopDiagnostics.log("info", "instances", "desktop-scoped", "Desktop operation line", { password: SEEDED_SECRETS[0] }, { file: "instances" });
    return { id, entry };
  });
  assert.strictEqual(desktopScoped.entry.correlationId, desktopScoped.id, "Desktop diagnostic lines inside a scope carry the scope id.");

  console.log("Checking the Agent action audit line...");
  const actionLines = [];
  let agentActionScopeId = null;
  const originalInfo = console.info;
  console.info = (line) => { actionLines.push(String(line)); };
  try {
    const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { "user-agent": `smoke Agent/Bearer ${SEEDED_SECRETS[1]}` } };
    agentDiagnostics.withOperationScope("agent-action", () => {
      agentActionScopeId = agentDiagnostics.currentCorrelationId();
      auditAction(request, { actionId: "diagnostics.export", permission: "owner", outcome: "ok", reason: "SANITIZED_BUNDLE" });
    });
    auditAction(request, { actionId: "instance.start", permission: "instance:lifecycle", outcome: "ok", reason: "UNCORRELATED" });
  } finally {
    console.info = originalInfo;
  }
  assert.strictEqual(actionLines.length, 2, "Both Agent action audit lines must be emitted.");
  const correlatedAction = JSON.parse(actionLines[0]);
  const uncorrelatedAction = JSON.parse(actionLines[1]);
  assert.strictEqual(correlatedAction.scope, "agent_action_audit", "The Agent action audit line keeps its scope marker.");
  assert(OPAQUE_ID.test(correlatedAction.correlationId), "An Agent action audit line inside a scope carries an opaque correlation id.");
  assert.strictEqual(correlatedAction.correlationId, agentActionScopeId, "The Agent action line carries the id of the scope it ran in.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(uncorrelatedAction, "correlationId"), false, "An uncorrelated Agent action line keeps its previous shape.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(uncorrelatedAction, "scope"), true, "Removing correlation must not change the other audit fields.");
  assert(!actionLines[0].includes(SEEDED_SECRETS[1]), "The Agent action line must redact the bearer token it observed.");

  console.log("Checking Agent structured logging propagation...");
  const agentScopedId = await agentDiagnostics.withOperationScope("agent-request", async () => {
    const id = agentDiagnostics.currentCorrelationId();
    agentDiagnostics.logger.info("agent-action", "Agent handled a correlated request", { agentToken: SEEDED_SECRETS[2] }, { file: "agent" });
    return id;
  });
  const agentLogPath = path.join(process.env.ANXOS_LOG_DIR, "agent.log");
  const agentLine = readJsonLines(agentLogPath).find((line) => line.operation === "agent-action");
  assert(agentLine, "The Agent structured logger must have written the correlated line.");
  assert.strictEqual(agentLine.correlationId, agentScopedId, "The Agent's own log line carries the scope id.");

  console.log("Checking the durable job record boundary...");
  const auditEvents = [];
  engine.setAuditEventEmitter((event) => { auditEvents.push(event); });
  const jobInstanceId = "corr-smoke-01";
  fs.mkdirSync(path.dirname(core._test.logPath(jobInstanceId, "stdout")), { recursive: true });
  // Stands in for the id the start path mints for one workload run (it cannot be
  // spawned here): the run owns its lines, independently of any operation.
  const runScopeId = createCorrelationId("instance");

  let workloadLineId = null;
  const jobResult = await withOperationScope("instances-start", async () => {
    const scopeId = currentCorrelationId();
    const created = await engine.createJob({
      type: "instance.start",
      target: { instanceId: jobInstanceId },
      timeoutMs: 5000,
      run: async () => {
        // The job run executes inside the operation scope that requested it, so
        // the workload log lines it writes join the same correlation id.
        workloadLineId = currentCorrelationId();
        await core._test.appendLog(jobInstanceId, "stdout", "Starting correlation smoke workload");
        await core._test.appendLog(jobInstanceId, "stderr", `token=${SEEDED_SECRETS[2]}`);
        return { pid: 4242 };
      },
    });
    return { scopeId, job: created.job };
  });
  assert.strictEqual(workloadLineId, jobResult.scopeId, "The job run executes inside the requesting operation scope.");
  assert.strictEqual(jobResult.job.state, "succeeded", "The correlated job settles succeeded.");

  // Regression pin (P2, found by adversarial review): a workload's pipes outlive
  // the operation that started them, so an operation scope must never reach into
  // a later write on the run's behalf. The start path binds the run to its own
  // id and passes it explicitly, which is what this leg proves: while an
  // unrelated operation scope is active, a line written for the run carries the
  // RUN's id — not the id of the operation that happens to be in flight.
  const foreignScopeStart = currentCorrelationId();
  await withOperationScope("unrelated-operation", async () => {
    const ambient = currentCorrelationId();
    assert(ambient && ambient !== runScopeId, "The unrelated operation must have its own id.");
    await core._test.appendLog(jobInstanceId, "stdout", "Server started", { correlationId: runScopeId });
    const lines = await core._test.readRecentLines(core._test.logPath(jobInstanceId, "stdout"), 5);
    const written = lines.map((line) => (typeof line === "string" ? JSON.parse(line) : line));
    const last = written[written.length - 1];
    assert.strictEqual(last.correlationId, runScopeId, "A workload line must carry the run's id, never a concurrently active operation's id.");
    assert.notStrictEqual(last.correlationId, ambient, "The unrelated operation's id must not be stamped onto another run's log line.");
  });
  assert.strictEqual(currentCorrelationId(), foreignScopeStart, "Entering and leaving a scope must not leave an ambient scope behind.");

  const recordFile = path.join(jobsRoot, `${jobResult.job.id}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.strictEqual(record.correlationId, jobResult.scopeId, "The durable job record carries the operation correlation id.");
  assert.strictEqual(record.id, jobResult.job.id, "The durable job id remains the primary key.");
  assert.strictEqual(jobResult.job.correlationId, jobResult.scopeId, "The public job view exposes the correlation id.");
  const enqueued = auditEvents.find((event) => event.action === "job.enqueued");
  assert(enqueued, "The injected audit sink must receive the enqueued job event.");
  assert.strictEqual(enqueued.correlationId, jobResult.scopeId, "The job audit event carries the same correlation id as the record.");
  assert.strictEqual(enqueued.jobId, jobResult.job.id, "The job audit event carries the durable job id as its join key.");

  const workloadLines = await core._test.readRecentLines(core._test.logPath(jobInstanceId, "stdout"), 20);
  // Two attributions coexist correctly in one run's log: the line written on the
  // job's behalf during the operation carries the operation id, while the line
  // written for the run itself carries the run's id.
  const jobStdoutLine = workloadLines.find((line) => line.message === "Starting correlation smoke workload");
  assert(jobStdoutLine, "The workload stdout log must contain the line the job wrote.");
  assert.strictEqual(jobStdoutLine.correlationId, jobResult.scopeId, "Workload log lines carry the operation correlation id.");
  const runStdoutLine = workloadLines.find((line) => line.message === "Server started");
  assert(runStdoutLine, "The workload stdout log must contain the run-owned line.");
  assert.strictEqual(runStdoutLine.correlationId, runScopeId, "A run-owned line carries the run's id, not the operation's.");
  const workloadErrLines = await core._test.readRecentLines(core._test.logPath(jobInstanceId, "stderr"), 20);
  assert.strictEqual(workloadErrLines[0].correlationId, jobResult.scopeId, "Workload stderr lines carry the operation correlation id too.");
  assert.strictEqual(workloadErrLines[0].message, "token=[redacted]", "Workload log lines are still redacted.");

  // The exported reader surface (the same `readLogs` the Agent `/logs` route and
  // the desktop instances bridge call) must surface the id to a client, not just
  // the internal line reader.
  fs.mkdirSync(path.dirname(core._test.logPath(jobInstanceId, "stdout")), { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_INSTANCE_ROOT, jobInstanceId, "config.json"), `${JSON.stringify({
    schemaVersion: core.INSTANCE_CONFIG_SCHEMA_VERSION,
    id: jobInstanceId,
    displayName: "Correlation Smoke",
  }, null, 2)}\n`);
  const readBack = await core.readLogs(jobInstanceId, { limit: 50, stream: "all" });
  assert(readBack.entries.length >= 2, "The exported log reader must return the workload lines.");
  // The reader must surface the id to a client for every correlated line — and
  // must report each line's OWN id, so the operation's line and the run's line
  // stay distinguishable on the client-visible surface.
  const clientOperationLines = readBack.entries.filter((entry) => entry.message === "Starting correlation smoke workload");
  const clientRunLines = readBack.entries.filter((entry) => entry.message === "Server started");
  assert(clientOperationLines.length && clientOperationLines.every((entry) => entry.correlationId === jobResult.scopeId), "The client-visible reader surfaces the operation correlation id on the operation's line.");
  assert(clientRunLines.length && clientRunLines.every((entry) => entry.correlationId === runScopeId), "The client-visible reader surfaces the run's own id on the run's line.");
  assert(readBack.entries.every((entry) => entry.correlationId), "Every line surfaced by the exported log reader carries some correlation id.");

  // An explicitly supplied opaque id reaches the record without any ambient scope.
  const explicitJobId = createCorrelationId("explicit-job");
  const explicitJob = await engine.createJob({ type: "instance.start", target: { instanceId: jobInstanceId }, correlationId: explicitJobId, timeoutMs: 5000, run: async () => ({ pid: 1 }) });
  const explicitRecord = JSON.parse(fs.readFileSync(path.join(jobsRoot, `${explicitJob.job.id}.json`), "utf8"));
  assert.strictEqual(explicitRecord.correlationId, explicitJobId, "An explicitly supplied correlation id reaches the durable record.");

  // Uncorrelated jobs keep their previous record shape exactly.
  const uncorrelatedJob = await engine.createJob({ type: "instance.start", target: { instanceId: jobInstanceId }, timeoutMs: 5000, run: async () => ({ pid: 2 }) });
  const uncorrelatedRecord = JSON.parse(fs.readFileSync(path.join(jobsRoot, `${uncorrelatedJob.job.id}.json`), "utf8"));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(uncorrelatedRecord, "correlationId"), false, "A job minted outside a scope must not gain a correlationId key.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(uncorrelatedJob.job, "correlationId"), false, "An uncorrelated public job view must not gain a correlationId key.");

  // Caller input can never become a record field, even when passed as an id.
  const userInputJob = await engine.createJob({
    type: "instance.start",
    target: { instanceId: jobInstanceId },
    correlationId: "/home/private-user/AnxOS/agent.json?token=corr-smoke-super-secret",
    timeoutMs: 5000,
    run: async () => ({ pid: 3 }),
  });
  const userInputRecord = JSON.parse(fs.readFileSync(path.join(jobsRoot, `${userInputJob.job.id}.json`), "utf8"));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(userInputRecord, "correlationId"), false, "User input must never be persisted as a correlation id.");
  assert(!fs.readFileSync(path.join(jobsRoot, `${userInputJob.job.id}.json`), "utf8").includes("agent.json"), "User input must not leak into the job record.");

  console.log("Checking that no secret escapes in any emitted line...");
  const emitted = [
    fs.readFileSync(path.join(scopeLogDir, "correlation.log"), "utf8"),
    fs.readFileSync(path.join(process.env.ANXOS_LOG_DIR, "instances.log"), "utf8"),
    fs.readFileSync(agentLogPath, "utf8"),
    fs.readFileSync(recordFile, "utf8"),
    fs.readFileSync(core._test.logPath(jobInstanceId, "stdout"), "utf8"),
    fs.readFileSync(core._test.logPath(jobInstanceId, "stderr"), "utf8"),
    actionLines.join("\n"),
  ].join("\n");
  for (const secret of SEEDED_SECRETS) {
    assert(!emitted.includes(secret), `No emitted line may contain the seeded secret ${secret.slice(0, 12)}...`);
  }
  const emittedIds = [...emitted.matchAll(/"correlationId":"([^"]*)"/g)].map((match) => match[1]);
  assert(emittedIds.length >= 7, `Correlation ids must actually reach the emitted artifacts (found ${emittedIds.length}).`);
  for (const id of emittedIds) {
    assert(OPAQUE_ID.test(id), `Every emitted correlation id must be opaque (got ${id}).`);
  }
  for (const event of auditEvents) {
    if (event.correlationId !== undefined) {
      assert(OPAQUE_ID.test(event.correlationId), "Every emitted job audit correlation id must be opaque.");
    }
    if (event.jobId !== undefined) {
      assert(OPAQUE_JOIN_KEY.test(event.jobId), "Job audit join keys must stay bounded and opaque.");
    }
  }

  phaseWireup();

  console.log("correlation-id-smoke passed");
}

// Phase: the boundaries that make the primitive live in production. A correct
// primitive is worthless if nothing ever enters a scope, so every operation
// entry point is pinned by direct file evidence — including the two ends of the
// desktop↔Agent header, which must agree on one spelling. The header's value
// handling is proven behaviorally against the same rule the Agent applies: an
// opaque id is adopted verbatim, anything else is ignored rather than
// sanitized into an id.
function phaseWireup() {
  console.log("Checking that every operation entry point actually opens a scope...");
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

  const ipcFamilies = [
    ["src/ipc/instancesIpc.js", "instance"],
    ["src/ipc/dockerIpc.js", "docker"],
    ["src/ipc/backupsIpc.js", "backup"],
    ["src/ipc/workloadIpc.js", "transfer"],
    ["src/ipc/dependenciesIpc.js", "dependencies"],
    ["src/ipc/marketplaceIpc.js", "marketplace"],
  ];
  for (const [file, prefix] of ipcFamilies) {
    const source = read(file);
    assert(source.includes(`runWithCorrelationScope({ prefix: "${prefix}" }`), `${file} must enter the "${prefix}" operation scope.`);
  }

  const core = read("src/shared/instances/instanceServiceCore.js");
  // A workload outlives its start operation, so the run binds its own id and
  // passes it explicitly at both pipe call sites: the run's lines must never be
  // attributed to whichever operation happens to be in flight (P2 regression).
  assert(core.includes('createCorrelationId("instance")'), "The workload start path must mint a per-run correlation id.");
  const explicitRunStamps = (core.match(/appendLog\(config\.id, "\w+", chunk, \{ correlationId: runCorrelationId \}\)/g) || []).length;
  assert.strictEqual(explicitRunStamps, 2, `Both workload pipes must stamp the run id explicitly (found ${explicitRunStamps} of 2).`);
  assert(core.includes("runWithCorrelationScope({ correlationId: runCorrelationId }"), "The spawn must run inside the run's own scope so its async resources do not inherit the caller's operation scope.");

  const agentServer = read("agent/src/server.js");
  assert(agentServer.includes("runWithRequestScope(request, () => routeRequest(request, url))"), "The Agent must dispatch an authorized request inside the correlation scope.");
  assert(agentServer.includes("request.headers?.[CORRELATION_HEADER]") && agentServer.includes("isCorrelationId(supplied) ? supplied : null"), "The Agent must adopt the header id only when it is opaque.");

  const client = read("src/services/agentClient.js");
  const headerApplications = (client.match(/applyCorrelationHeader\(headers\);/g) || []).length;
  assert.strictEqual(headerApplications, 3, `Every Agent request builder must forward the correlation id (found ${headerApplications} of 3).`);
  assert(client.includes("CORRELATION_HEADER, currentCorrelationId") && client.includes("shared/structuredLogger"), "The desktop must reuse the shared header constant rather than a local literal.");

  console.log("Checking that an opaque header id is adopted and anything else is ignored...");
  const adopted = createCorrelationId("instance");
  const scope = runWithCorrelationScope({ correlationId: adopted, prefix: "agent" }, () => currentCorrelation());
  assert.strictEqual(scope.id, adopted, "A valid opaque header id must be adopted verbatim so both processes share one id.");
  assert.strictEqual(scope.prefix, "instance", "An adopted id keeps its own prefix rather than being re-labelled.");
  const hostileValues = ["/home/private-user/AnxOS/agent.json", "corr-not-a-uuid", "CORR-01234567-89ab-cdef-0123-456789abcdef", "", "Bearer opaque.agent.token"];
  for (const hostile of hostileValues) {
    assert.strictEqual(isCorrelationId(hostile), false, "A header value that is not an opaque id must be refused, never sanitized into one.");
  }
  const minted = runWithCorrelationScope({ prefix: "agent" }, () => currentCorrelationId());
  assert(OPAQUE_ID.test(minted) && minted.startsWith("agent-"), "Without a usable header the Agent mints its own opaque id.");
}

main()
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }))
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });