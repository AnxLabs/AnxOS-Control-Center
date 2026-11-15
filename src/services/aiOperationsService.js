"use strict";

// Phase X: main-process wiring of the optional assistant.
//
// This is the only place the assistant touches real services, and it does so
// through the same functions, permission tokens and audit actions as the
// normal IPC handlers (instancesIpc, dockerIpc, backupsIpc, systemIpc). Read
// tools run under the signed-in user's permissions; operational tools run only
// after the approval broker authorized the exact proposal, and the permission
// is checked again at execution time. Results are verified by reading the state
// back, never inferred from a command returning.
//
// Dependencies are injected so the service can be tested without Electron;
// createDefaultDependencies() loads the real ones lazily on first use.

const fs = require("fs");
const path = require("path");
const { createApprovalBroker } = require("../shared/aiOperations/approvalBroker");
const { createAssistant } = require("../shared/aiOperations/assistant");
const { createProvider } = require("../shared/aiOperations/providers");
const { getTool } = require("../shared/aiOperations/toolRegistry");
const { diagnoseContainers, diagnoseJoin, diagnoseServer, normalizeLines } = require("../shared/aiOperations/diagnostics");
const { makeObservation, untrustedText } = require("../shared/aiOperations/observation");

const JOURNAL_FILE = "ai-operations.json";
const MAX_CONCURRENT_ASKS = 2;
const MAX_CONCURRENT_OPERATIONS = 2;
const VERIFY_INTERVAL_MS = 3000;

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function withTimeout(promise, timeoutMs, code = "AI_TOOL_TIMEOUT") {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(serviceError(code, "The request took too long.")), timeoutMs); }),
  ]);
}

function list(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

// Instance records (desktop and Agent share instanceServiceCore) carry `state`
// ("Running", "Failed", ...), a friendlier `lifecycleState` ("Crashed",
// "Crash Loop") and `readinessState` ("ready", "timeout", ...).
function normalizeInstance(instance, nodeId) {
  const id = String(instance?.id || instance?.instanceId || "");
  const lifecycle = String(instance?.lifecycleState || "");
  const rawState = /crash/i.test(lifecycle) ? lifecycle : (instance?.status || instance?.state || "unknown");
  return {
    id,
    nodeId,
    name: untrustedText(instance?.displayName || instance?.name || id, 80),
    game: untrustedText(instance?.game || instance?.gameId || instance?.templateId || instance?.type || instance?.serverType || "", 40),
    state: untrustedText(rawState, 40).toLowerCase(),
    readiness: instance?.readinessState ? untrustedText(instance.readinessState, 20).toLowerCase() : null,
    version: instance?.version || instance?.serverVersion || instance?.detectedVersion ? untrustedText(instance.version || instance.serverVersion || instance.detectedVersion, 40) : null,
    updateAvailable: instance?.updateAvailable === true ? true : null,
    restartCount: Number.isFinite(Number(instance?.restartCount)) ? Number(instance.restartCount) : null,
    crashLoop: instance?.crashLoop === true || instance?.health?.crashLoop === true,
  };
}

function normalizeContainer(container) {
  const name = String(container?.name || (Array.isArray(container?.Names) ? container.Names[0] : container?.Names) || container?.id || "").replace(/^\//, "");
  return {
    id: String(container?.id || container?.Id || name).slice(0, 80),
    name: untrustedText(name, 80),
    image: untrustedText(container?.image || container?.Image || "", 120),
    state: untrustedText(container?.state || container?.State || "", 20).toLowerCase(),
    status: untrustedText(container?.status || container?.Status || "", 120),
    health: untrustedText(container?.health || container?.Health || "", 20).toLowerCase(),
    restartCount: Number.isFinite(Number(container?.restartCount ?? container?.RestartCount)) ? Number(container.restartCount ?? container.RestartCount) : null,
    exitCode: Number.isFinite(Number(container?.exitCode)) ? Number(container.exitCode) : null,
  };
}

function playersOf(result) {
  const source = result?.players ?? result;
  const online = Number(source?.online ?? source?.count ?? (Array.isArray(source?.list) ? source.list.length : Array.isArray(source) ? source.length : NaN));
  if (!Number.isFinite(online)) return null;
  const max = Number(source?.max ?? source?.maxPlayers);
  return { online, max: Number.isFinite(max) ? max : null };
}

function createAiOperationsService(deps) {
  const {
    readSettings,
    requirePermission,
    audit,
    getCurrentUser,
    services,
    configDir,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl,
  } = deps;

  let broker = null;
  let activeAsks = 0;
  let activeOperations = 0;
  const controllers = new Set();

  function settings() {
    return readSettings();
  }

  function assertEnabled() {
    if (settings()["ai.enabled"] !== true) throw serviceError("AI_DISABLED", "AI assistance is turned off. An Owner can turn it on in Settings.");
  }

  function journalPath() {
    return configDir ? path.join(configDir(), JOURNAL_FILE) : null;
  }

  function persist() {
    const file = journalPath();
    if (!file || !broker) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, records: broker.journal() }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      // The audit log stays the durable record; a failed journal write only
      // loses the assistant's own list.
    }
  }

  function loadJournal() {
    const file = journalPath();
    if (!file) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed?.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  function getBroker() {
    if (!broker) {
      broker = createApprovalBroker({
        now,
        initialJournal: loadJournal(),
        onTransition: (record) => {
          audit({ action: `ai.operation.${record.state}`, target: `${record.tool}:${record.target.nodeId || "-"}/${record.target.instanceId || record.target.container || "-"}`, reason: record.id });
          persist();
        },
      });
      persist();
    }
    return broker;
  }

  function actorOrThrow() {
    const user = getCurrentUser();
    if (!user || !(user.id || user.username)) throw serviceError("LOGIN_REQUIRED", "Sign in to use the assistant.");
    return user;
  }

  // ---- read tools ---------------------------------------------------------

  async function readComputers() {
    const summaries = await services.listComputerSummaries();
    const rows = list(summaries, "computers", "summaries");
    const time = now();
    const computers = [];
    const observations = [];
    for (const summary of rows) {
      if (!summary?.id) continue;
      const computer = {
        id: summary.id,
        name: untrustedText(summary.name || summary.id, 80),
        kind: summary.kind,
        os: summary.os ? untrustedText(summary.os, 60) : null,
        agentVersion: summary.agentVersion ? untrustedText(summary.agentVersion, 40) : null,
        online: summary.online,
        lastContact: summary.lastContact || null,
        lastContactStale: summary.lastContactStale === true,
        connectivity: summary.connectivity || null,
        cpu: summary.cpu, memory: summary.memory, disk: summary.disk,
      };
      computers.push(computer);
      const target = { nodeId: summary.id, label: computer.name };
      const common = { target, observedAt: summary.lastContact, reportedStale: summary.lastContactStale === true || summary.online === false, now: time, note: "From the computer's last health check." };
      observations.push(
        makeObservation({ source: "computer.cpu", label: `${computer.name} CPU`, value: summary.cpu?.usagePercent ?? null, unit: "%", ...common }),
        makeObservation({ source: "computer.memory", label: `${computer.name} memory`, value: summary.memory?.percent ?? null, unit: "%", ...common }),
        makeObservation({ source: "computer.disk", label: `${computer.name} disk`, value: summary.disk?.percent ?? null, unit: "%", ...common }),
      );
    }
    return { data: { computers }, observations };
  }

  async function readSnapshot(nodeId) {
    const snapshot = await services.getSystemSnapshot({ nodeId });
    const time = now();
    const target = { nodeId };
    const cpuPercent = Number(snapshot?.cpu?.usagePercent ?? snapshot?.cpu?.percent ?? snapshot?.cpu?.usage);
    const memory = snapshot?.memory && Number.isFinite(Number(snapshot.memory.total)) ? { total: Number(snapshot.memory.total), used: Number(snapshot.memory.used), free: Number(snapshot.memory.free ?? (snapshot.memory.total - snapshot.memory.used)), percent: Number(snapshot.memory.percent) } : null;
    const disk = snapshot?.disk && Number.isFinite(Number(snapshot.disk.total)) ? { total: Number(snapshot.disk.total), used: Number(snapshot.disk.used), free: Number(snapshot.disk.free), percent: Number(snapshot.disk.percent) } : null;
    const observations = [
      makeObservation({ source: "system.cpu", label: "CPU", value: Number.isFinite(cpuPercent) ? cpuPercent : null, unit: "%", target, observedAt: time, now: time }),
      makeObservation({ source: "system.memory", label: "Memory", value: memory && Number.isFinite(memory.percent) ? memory.percent : null, unit: "%", target, observedAt: time, now: time }),
      makeObservation({ source: "system.disk", label: "Disk", value: disk && Number.isFinite(disk.percent) ? disk.percent : null, unit: "%", target, observedAt: time, now: time }),
    ];
    return { memory, disk, observations, snapshot };
  }

  async function readServerStatus(nodeId, instanceId) {
    const status = await services.getInstanceStatus(instanceId, { nodeId });
    const instance = status?.instance || status || {};
    const server = normalizeInstance({ id: instanceId, ...instance }, nodeId);
    let players = null;
    try { players = playersOf(await withTimeout(services.getInstancePlayers(instanceId, { nodeId }), 8000)); } catch { players = null; }
    server.players = players;
    const time = now();
    return {
      server,
      observations: [
        makeObservation({ source: "server.state", label: `${server.name} state`, value: server.state, target: { nodeId, instanceId, label: server.name }, observedAt: time, now: time, kind: "verified" }),
        makeObservation({ source: "server.players", label: `${server.name} players online`, value: players ? players.online : null, target: { nodeId, instanceId }, observedAt: time, now: time, note: players ? null : "This server does not report players." }),
      ],
    };
  }

  // The server's own cached connectivity check (cache only, never a probe).
  // No cached evaluation reads as "not measured", never as another server's.
  async function readServerPublicReachability(nodeId, instanceId) {
    if (typeof services.getCachedDiagnostics !== "function") return null;
    try {
      const cached = await withTimeout(services.getCachedDiagnostics({ nodeId, serviceId: instanceId }), 5000);
      if (!cached || typeof cached !== "object" || cached.cached === false) return null;
      const scopes = cached.reachability && typeof cached.reachability === "object" ? cached.reachability : cached.scopes;
      return typeof scopes?.public === "string" && scopes.public ? scopes.public : null;
    } catch {
      return null;
    }
  }

  const READERS = {
    "computers.list": async () => readComputers(),
    "computer.status": async ({ nodeId }) => {
      const computers = await readComputers();
      const computer = computers.data.computers.find((entry) => entry.id === nodeId) || null;
      const live = await readSnapshot(nodeId);
      return { data: { computer: computer && { ...computer, memoryBytes: live.memory, diskBytes: live.disk } }, observations: live.observations };
    },
    "servers.list": async ({ nodeId }) => {
      const result = await services.listInstances({ nodeId });
      const servers = list(result, "instances").map((instance) => normalizeInstance(instance, nodeId)).filter((server) => server.id);
      return { data: { servers }, observations: [] };
    },
    "server.status": async ({ nodeId, instanceId }) => {
      const status = await readServerStatus(nodeId, instanceId);
      return { data: { server: status.server }, observations: status.observations };
    },
    "server.logs": async ({ nodeId, instanceId }, args) => {
      const logs = await services.getInstanceLogs(instanceId, { nodeId, limit: args.lines || 200 });
      const lines = normalizeLines(logs).slice(-(args.lines || 200)).map((line) => untrustedText(line, 300));
      return { data: { lines }, observations: [makeObservation({ source: "server.logs", label: "Console lines", value: lines.length, target: { nodeId, instanceId }, observedAt: now(), now: now() })] };
    },
    "server.diagnose": async ({ nodeId, instanceId }) => {
      const status = await readServerStatus(nodeId, instanceId);
      let logs = null;
      const missing = [];
      try { logs = await withTimeout(services.getInstanceLogs(instanceId, { nodeId, limit: 300 }), 10000); } catch (error) { missing.push(`Console lines could not be read (${error.code || "error"}).`); }
      let computer = null;
      try { computer = (await readComputers()).data.computers.find((entry) => entry.id === nodeId) || null; } catch { computer = null; }
      const result = diagnoseServer({ logs, status: status.server, computer });
      // The computer's connectivity merges every server's checks (worst wins),
      // so only this server's own cached check speaks for this server.
      const publicReachability = await readServerPublicReachability(nodeId, instanceId);
      const join = diagnoseJoin({ server: status.server, computer, connectivity: publicReachability ? { public: publicReachability } : null });
      return { data: { server: status.server, findings: result.findings, missing: [...missing, ...result.missing], linesExamined: result.linesExamined, join }, observations: status.observations };
    },
    "docker.containers": async ({ nodeId }) => {
      const result = await services.listDockerContainers({ nodeId });
      const containers = list(result, "containers").map(normalizeContainer);
      return { data: { containers }, observations: [makeObservation({ source: "docker.containers", label: "Containers", value: containers.length, target: { nodeId }, observedAt: now(), now: now() })] };
    },
    "docker.diagnose": async ({ nodeId }) => {
      const result = await services.listDockerContainers({ nodeId });
      const containers = list(result, "containers").map(normalizeContainer);
      const diagnosis = diagnoseContainers(containers);
      return { data: diagnosis, observations: [makeObservation({ source: "docker.containers", label: "Containers checked", value: containers.length, target: { nodeId }, observedAt: now(), now: now() })] };
    },
    "network.status": async () => {
      const computers = await readComputers();
      let anxnet = null;
      try {
        const status = await withTimeout(services.anxnetStatus(), 5000);
        const peers = list(status?.network, "devices", "peers").length || list(status, "devices", "peers").length || null;
        anxnet = { state: status?.running ? "running" : "not running", summary: status?.running ? `running${status?.network?.name ? ` in "${untrustedText(status.network.name, 60)}"` : ""}${peers ? `, ${peers} devices` : ""}` : "not running on this PC" };
      } catch {
        anxnet = null;
      }
      return { data: { computers: computers.data.computers, anxnet }, observations: computers.observations };
    },
    "capacity.check": async ({ nodeId }) => {
      const live = await readSnapshot(nodeId);
      return { data: { memory: live.memory, disk: live.disk }, observations: live.observations };
    },
    "setup.plan": async () => ({ data: {}, observations: [] }),
  };

  async function executeReadTool(call, actor) {
    void actor;
    const definition = call.definition;
    if (definition.category !== "read") throw serviceError("AI_TOOL_NOT_READ", "Only read tools run without approval.");
    assertEnabled();
    requirePermission(definition.permission, call.target.instanceId || call.target.container || call.target.nodeId || "ai-assistant");
    const reader = READERS[definition.id];
    if (!reader) throw serviceError("AI_TOOL_UNKNOWN", "That tool has no reader.");
    return withTimeout(reader(call.target, call.args), definition.timeoutMs);
  }

  // Checked before a proposal is shown, and again when it runs.
  function checkPermission(call) {
    requirePermission(call.definition.permission, call.target.instanceId || call.target.container || call.target.nodeId);
  }

  // ---- operational tools -------------------------------------------------

  async function pollUntil(read, accept, { attempts, intervalMs = VERIFY_INTERVAL_MS }) {
    let last = null;
    let readFailures = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(intervalMs);
      try {
        last = await read();
        readFailures = 0;
        const verdict = accept(last);
        if (verdict) return { verdict, last };
      } catch {
        readFailures += 1;
      }
    }
    return { verdict: readFailures === attempts || (last === null) ? "unreadable" : "timeout", last };
  }

  // A start or restart is verified only when the server reports ready (or,
  // for servers that report no readiness, running). "Running but not ready"
  // at the end of the wait is reported as not verified, never as success.
  function instanceVerifier(target, expected, attempts, { needsReady = false } = {}) {
    return async () => {
      const outcome = await pollUntil(
        async () => {
          const status = await services.getInstanceStatus(target.instanceId, { nodeId: target.nodeId });
          return normalizeInstance({ id: target.instanceId, ...(status?.instance || status || {}) }, target.nodeId);
        },
        (server) => {
          if (/crash|fail|error/.test(server.state)) return "failed";
          if (!expected.test(server.state)) return null;
          if (!needsReady || !server.readiness || server.readiness === "ready" || server.readiness === "unknown") return "reached";
          return null;
        },
        { attempts },
      );
      const state = outcome.last?.state || "unknown";
      const readiness = outcome.last?.readiness;
      if (outcome.verdict === "reached") {
        const readyText = needsReady ? (readiness === "ready" ? " and ready" : " (this server does not report readiness)") : "";
        return { state: "succeeded", message: `Verified: the server reports "${state}"${readyText}.`, observedState: state };
      }
      if (outcome.verdict === "timeout" && needsReady && expected.test(state)) {
        return { state: "verification_unavailable", message: `The server is running but has not reported ready yet (readiness: ${readiness || "unknown"}). Check it before telling players it is up.`, observedState: state };
      }
      if (outcome.verdict === "failed") return { state: "failed", message: `The command ran, but the server reports "${state}". Ask the assistant why it is failing.`, observedState: state };
      if (outcome.verdict === "unreadable") return { state: "verification_unavailable", message: "The command was sent, but the server's state could not be read back, so the result is not verified." };
      return { state: "failed", message: `The server did not reach the expected state in time; it last reported "${state}".`, observedState: state };
    };
  }

  const EXECUTORS = {
    "server.start": { scope: "instance", run: (t) => services.startInstance(t.instanceId, { nodeId: t.nodeId }), verify: (t) => instanceVerifier(t, /^(running|online|ready)/, 30, { needsReady: true }) },
    "server.stop": { scope: "instance", run: (t) => services.stopInstance(t.instanceId, { nodeId: t.nodeId }), verify: (t) => instanceVerifier(t, /^(stopped|offline|exited)/, 20) },
    "server.restart": { scope: "instance", run: (t) => services.restartInstance(t.instanceId, { nodeId: t.nodeId }), verify: (t) => instanceVerifier(t, /^(running|online|ready)/, 40, { needsReady: true }) },
    "backup.create": {
      scope: "backup",
      run: (t, args, actor) => services.createBackup({ nodeId: t.nodeId, instanceId: t.instanceId, name: `${t.instanceId} ${args.type || "full"} backup`, type: args.type || "full", createdBy: actor.username || "assistant" }),
      verify: (t, _args, result) => async () => {
        const backupId = result?.backup?.id || result?.id || null;
        try {
          const backups = list(await services.listBackups({ nodeId: t.nodeId }), "backups");
          const found = backupId ? backups.find((entry) => entry?.id === backupId) : null;
          if (found) return { state: "succeeded", message: `Verified: backup ${untrustedText(found.name || found.id, 80)} is listed.` };
          return { state: "failed", message: "The backup request returned, but the new backup is not in the list." };
        } catch {
          return { state: "verification_unavailable", message: "The backup was requested, but the backup list could not be read to confirm it." };
        }
      },
    },
    "docker.container.restart": {
      scope: "docker",
      run: (t) => services.restartDockerContainer(t.container, { nodeId: t.nodeId }),
      verify: (t) => async () => {
        const outcome = await pollUntil(async () => list(await services.listDockerContainers({ nodeId: t.nodeId }), "containers").map(normalizeContainer).find((entry) => entry.id === t.container || entry.name === t.container) || null,
          (container) => (container && container.state === "running" ? "reached" : null), { attempts: 10 });
        if (outcome.verdict === "reached") return { state: "succeeded", message: `Verified: the container is running${outcome.last.health ? ` (${outcome.last.health})` : ""}.` };
        if (outcome.verdict === "unreadable") return { state: "verification_unavailable", message: "The restart was sent, but the container list could not be read back." };
        return { state: "failed", message: `The container did not report running in time (last state "${outcome.last?.state || "unknown"}").` };
      },
    },
  };

  async function runAuthorized(authorized, actor) {
    const definition = getTool(authorized.tool);
    const executor = EXECUTORS[authorized.tool];
    const b = getBroker();
    if (!definition || definition.category !== "operational" || !executor) {
      b.markRunning(authorized.id);
      return b.finish(authorized.id, "failed", { ok: false, message: "That operation is not supported." });
    }
    const target = authorized.target;
    try {
      // Fresh checks at execution time: the assistant must still be on and the
      // person must still hold the permission the normal page requires.
      assertEnabled();
      requirePermission(definition.permission, target.instanceId || target.container || target.nodeId);
    } catch (error) {
      b.markRunning(authorized.id);
      return b.finish(authorized.id, "failed", { ok: false, code: error.code || "PERMISSION_DENIED", message: error.message });
    }
    b.markRunning(authorized.id);
    audit({ action: definition.auditAction, target: target.instanceId || target.container || target.nodeId, reason: `ai:${authorized.id}` });
    let result;
    try {
      result = await withTimeout(services.runInScope(executor.scope, () => executor.run(target, authorized.args, actor)), definition.timeoutMs, "AI_OPERATION_TIMEOUT");
    } catch (error) {
      return b.finish(authorized.id, "failed", { ok: false, code: error.code || null, message: untrustedText(error.message || "The operation failed.", 240) });
    }
    try {
      const verification = await executor.verify(target, authorized.args, result)();
      return b.finish(authorized.id, verification.state, { ok: verification.state === "succeeded", message: verification.message, observedState: verification.observedState || null, verifiedAt: new Date(now()).toISOString() });
    } catch {
      return b.finish(authorized.id, "verification_unavailable", { ok: false, message: "The operation ran, but its result could not be verified." });
    }
  }

  // ---- public API ---------------------------------------------------------

  async function chooseProvider() {
    const current = settings();
    const provider = createProvider(current, { fetchImpl });
    const notes = [];
    if (provider.id === "ollama" && !provider.config.remote && current["ai.avoidLocalGameServers"] !== false) {
      // Keep inference off this PC while it hosts game servers.
      try {
        const running = await withTimeout(services.listLocalRunningServers(), 5000);
        if (running > 0) {
          notes.push(`The local model was not used because ${running} game server${running === 1 ? " is" : "s are"} running on this PC. Answers come from measurements only.`);
          return { provider: createProvider({ "ai.provider": "deterministic" }), notes };
        }
      } catch {
        // Could not tell; fall through to the configured provider.
      }
    }
    if (provider.id === "sona") notes.push("Sona is not connected yet; answers come from measurements only.");
    return { provider: provider.id === "sona" ? createProvider({ "ai.provider": "deterministic" }) : provider, notes };
  }

  async function ask(payload = {}) {
    assertEnabled();
    const actor = actorOrThrow();
    if (activeAsks >= MAX_CONCURRENT_ASKS) throw serviceError("AI_BUSY", "The assistant is still working on another question.");
    const question = String(payload.question || "").slice(0, 500);
    const context = {
      selectedNodeId: typeof payload.context?.selectedNodeId === "string" ? payload.context.selectedNodeId : null,
      selectedInstanceId: typeof payload.context?.selectedInstanceId === "string" ? payload.context.selectedInstanceId : null,
    };
    activeAsks += 1;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const { provider, notes } = await chooseProvider();
      const assistant = createAssistant({ executeReadTool, checkPermission, broker: getBroker(), provider, settings: settings(), now });
      const response = await assistant.ask({ question, context, actor, signal: controller.signal });
      response.details.push(...notes);
      audit({ action: "ai.ask", target: response.intent, reason: response.provider.used ? `model:${response.provider.model || response.provider.id}` : "deterministic" });
      return response;
    } finally {
      activeAsks -= 1;
      controllers.delete(controller);
    }
  }

  async function proposeRepair(payload = {}) {
    assertEnabled();
    const actor = actorOrThrow();
    const { provider } = await chooseProvider();
    const assistant = createAssistant({ executeReadTool, checkPermission, broker: getBroker(), provider, settings: settings(), now });
    return assistant.proposeRepair({ tool: payload.tool, target: payload.target, actor });
  }

  // payload: exactly { proposalId, digest }. Anything else (tool, target,
  // args) is refused, so arguments can never be swapped at approval time.
  async function approve(payload = {}) {
    assertEnabled();
    const actor = actorOrThrow();
    const extra = Object.keys(payload || {}).filter((key) => key !== "proposalId" && key !== "digest");
    if (extra.length) throw serviceError("AI_PROPOSAL_MODIFIED", "An approval carries only the proposal id and its digest. Nothing was run.");
    if (activeOperations >= MAX_CONCURRENT_OPERATIONS) throw serviceError("AI_BUSY", "Two assistant operations are already running. Wait for one to finish.");
    const authorized = getBroker().authorize({ proposalId: payload.proposalId, digest: payload.digest, actor });
    activeOperations += 1;
    try {
      return await runAuthorized(authorized, actor);
    } finally {
      activeOperations -= 1;
    }
  }

  async function reject(payload = {}) {
    const actor = actorOrThrow();
    return getBroker().reject({ proposalId: payload.proposalId, actor });
  }

  function cancel() {
    let count = 0;
    for (const controller of controllers) { controller.abort(); count += 1; }
    return { cancelledQuestions: count };
  }

  function history() {
    assertEnabled();
    return { operations: getBroker().list().slice(0, 50) };
  }

  // Called when the setting turns off: stop model calls and cancel proposals
  // that were never approved. Running operations are not interrupted (a game
  // server is never stopped because the assistant was turned off).
  function onDisabled() {
    cancel();
    const cancelled = broker ? broker.cancelPending("The assistant was turned off.") : 0;
    return { cancelledProposals: cancelled };
  }

  async function status() {
    const current = settings();
    const enabled = current["ai.enabled"] === true;
    const result = {
      enabled,
      provider: current["ai.provider"],
      ollamaUrl: current["ai.ollamaUrl"],
      ollamaModel: current["ai.ollamaModel"],
      allowRemoteProvider: current["ai.allowRemoteProvider"] === true,
      health: null,
    };
    return result;
  }

  async function testProvider() {
    const current = settings();
    try {
      const provider = createProvider(current, { fetchImpl });
      return await provider.health();
    } catch (error) {
      return { provider: current["ai.provider"], available: false, reason: error.message, code: error.code || null };
    }
  }

  return { approve, ask, cancel, history, onDisabled, proposeRepair, reject, status, testProvider, _test: { executeReadTool, getBroker, READERS, EXECUTORS } };
}

// Real dependencies, loaded only when the assistant is first used.
function createDefaultDependencies() {
  const preferences = require("./settingsPreferenceService");
  const security = require("./securityService");
  // Feature services load on first use, not when the assistant starts.
  const router = new Proxy({}, { get: (_target, name) => require("./serviceRouter")[name] });
  const computerService = { listComputerSummaries: (...args) => require("./computerService").listComputerSummaries(...args) };
  const systemService = { getSystemSnapshot: (...args) => require("./systemService").getSystemSnapshot(...args) };
  const nodeService = new Proxy({}, { get: (_target, name) => require("./nodeService")[name] });
  const runWithCorrelationScope = (...args) => require("../shared/structuredLogger").runWithCorrelationScope(...args);
  return {
    readSettings: () => preferences.readPreferences().settings,
    requirePermission: security.requirePermission,
    audit: security.audit,
    getCurrentUser: () => {
      const status = security.getStatus();
      if (status.user) return status.user;
      return status.setupRequired ? { id: "local-device", username: "This Device", role: "Local" } : null;
    },
    configDir: () => path.dirname(preferences.getSettingsPath()),
    services: {
      listComputerSummaries: () => computerService.listComputerSummaries(),
      getCachedDiagnostics: (filter) => require("./connectivityDiagnosticsService").getCachedDiagnostics(filter),
      getSystemSnapshot: (options) => systemService.getSystemSnapshot(options),
      listInstances: (options) => router.listInstances(options),
      getInstanceStatus: (id, options) => router.getInstanceStatus(id, options),
      getInstanceLogs: (id, options) => router.getInstanceLogs(id, options),
      getInstancePlayers: (id, options) => router.getInstancePlayers(id, options),
      listDockerContainers: (options) => router.listDockerContainers(options),
      anxnetStatus: () => require("./anxnetService").status(),
      startInstance: (id, options) => router.startInstance(id, options),
      stopInstance: (id, options) => router.stopInstance(id, options),
      restartInstance: (id, options) => router.restartInstance(id, options),
      createBackup: (payload) => router.createBackup(payload),
      listBackups: (options) => router.listBackups(options),
      restartDockerContainer: (container, options) => router.restartDockerContainer(container, options),
      runInScope: (prefix, operation) => runWithCorrelationScope({ prefix }, operation),
      listLocalRunningServers: async () => {
        const local = nodeService.getAllNodesSync().filter((node) => node?.localAgent === true || node?.id === nodeService.APPLICATION_HOST_NODE_ID);
        let running = 0;
        for (const node of local) {
          try {
            const instances = list(await router.listInstances({ nodeId: node.id }), "instances");
            running += instances.filter((instance) => /^(running|online|ready|starting)/i.test(String(instance?.status || instance?.state || ""))).length;
          } catch {
            // Unreachable local node: nothing known to be running there.
          }
        }
        return running;
      },
    },
  };
}

let defaultService = null;
function getAiOperationsService() {
  if (!defaultService) defaultService = createAiOperationsService(createDefaultDependencies());
  return defaultService;
}

module.exports = {
  createAiOperationsService,
  getAiOperationsService,
};
