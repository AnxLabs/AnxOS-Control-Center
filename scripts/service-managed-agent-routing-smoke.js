"use strict";

// Desktop service layer <-> REAL Agent HTTP server, for a service-managed
// ("systemd-service") instance. Only systemd is replaced (a state file); the
// Agent process, its HTTP API, auth, instance core and the desktop's
// serviceRouter/agentClient are production code.
//
// Proves, end to end across the real client/server boundary:
//   - status mirrors the service, with no Agent-held PID;
//   - start/stop/restart reach systemd as exactly one control call each and the
//     Agent never launches a child process while doing so;
//   - unsupported operations and unverified state fail with the Agent's own
//     user-facing messages, preserved by the desktop error mapping;
//   - the desktop's template dependency pre-check never gates or installs for a
//     service-managed instance;
//   - the instance record is never rewritten by any of it.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-svc-routing-"));
process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

function writeJson(name, value) {
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function expectError(promise, code, label) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected ${code} but the call succeeded`);
  return null;
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  try {
    writeJson("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
    writeJson("nodes.json", {
      schemaVersion: 2,
      selectedNodeId: "ovh",
      nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true, agentIdentity: { deviceId: "device-ovh" } }],
    });
    writeJson("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });

    const router = require("../src/services/serviceRouter");
    const agentClient = require("../src/services/agentClient");
    const { resolveTemplateDependencyIds } = require("../src/shared/marketplaceDependencies");
    const options = { nodeId: "ovh" };
    const id = agent.instanceId;
    const recordSha = agent.recordSha();

    // Agent start-up legitimately spawns helpers (archive tools etc.); only what
    // happens AFTER this point is attributable to instance operations.
    agent.clearRecords();

    // --- status mirrors the service ------------------------------------------
    let list = await router.listInstances(options);
    let instance = list.instances.find((entry) => entry.id === id);
    assert.ok(instance, "the service-managed instance must be listed");
    assert.strictEqual(instance.type, "systemd-service");
    assert.strictEqual(instance.state, "Running");
    assert.strictEqual(instance.processRunning, true);
    assert.strictEqual(instance.pid, null, "the Agent must hold no PID for a service it does not own");
    assert.strictEqual(instance.runtimeProcess, null);
    assert.strictEqual(instance.serviceStatus.externalMainPid, 4242, "systemd's PID is informational only");
    assert.strictEqual(instance.serviceStatus.unit, agent.unit);
    assert.strictEqual(instance.readinessState, "ready");

    // --- start on a running service is refused and does nothing -----------------
    const already = await expectError(router.startInstance(id, options), "INSTANCE_ALREADY_RUNNING", "start while running");
    assert.match(already.message, /already running/i);
    assert.deepStrictEqual(agent.controlCalls(), [], "no control call may be made for a refused start");

    // --- stop / start / restart are single systemd calls -------------------------
    await router.stopInstance(id, options);
    assert.deepStrictEqual(agent.controlCalls(), [["stop", agent.unit]]);
    list = await router.listInstances(options);
    assert.strictEqual(list.instances.find((entry) => entry.id === id).state, "Stopped");
    assert.strictEqual(list.instances.find((entry) => entry.id === id).processRunning, false);

    agent.clearRecords();
    await router.startInstance(id, options);
    assert.deepStrictEqual(agent.controlCalls(), [["start", agent.unit]]);
    assert.strictEqual((await router.listInstances(options)).instances.find((entry) => entry.id === id).state, "Running");

    agent.clearRecords();
    await router.restartInstance(id, options);
    assert.deepStrictEqual(agent.controlCalls(), [["restart", agent.unit]], "restart must be one atomic service-manager restart");

    // --- the Agent never launches anything while doing the above -----------------
    assert.deepStrictEqual(agent.spawnAttempts(), [], `the Agent must not launch a child process during lifecycle operations: ${JSON.stringify(agent.spawnAttempts())}`);

    // --- unsupported operations: Agent's message survives the desktop mapping ----
    agent.clearRecords();
    const unsupported = "SERVICE_MANAGED_OPERATION_UNSUPPORTED";
    const commandError = await expectError(router.sendInstanceCommand(id, "refresh", options), unsupported, "console command");
    assert.match(commandError.message, /not available for a service-managed instance/i);
    await expectError(router.forceKillInstance(id, options), unsupported, "force kill");
    await expectError(router.deleteInstance(id, options), unsupported, "delete");
    await expectError(router.updateInstance(id, { displayName: "renamed" }, options), unsupported, "update");
    const backup = await agent.api("POST", "/api/v1/backups", { instanceId: id, type: "full" });
    assert.strictEqual(backup.status, 409, "backups of a service-managed instance must be refused");
    assert.strictEqual(backup.json?.error?.code, "BACKUP_SERVICE_MANAGED_UNSUPPORTED");
    assert.deepStrictEqual(agent.controlCalls(), [], "refused operations must never reach the service");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "refused operations must never launch a process");

    // --- logs: journal, redacted, degrading honestly -------------------------------
    const logs = await router.getInstanceLogs(id, { ...options, limit: 50 });
    const messages = (logs.entries || []).map((entry) => entry.message).join("\n");
    assert.ok(/AnxRP READY/.test(messages), "journal lines must be served");
    assert.ok(/Requested service restart/.test(messages), "Agent action notes are merged in");
    assert.ok(!/hunter2secretvalue/.test(messages), "secrets in journal lines must be redacted");
    agent.patchState({ journalError: "SERVICE_LOGS_DENIED" });
    const degraded = await router.getInstanceLogs(id, { ...options, limit: 50 });
    assert.ok(degraded.entries.some((entry) => /journal unavailable \(SERVICE_LOGS_DENIED\)/.test(entry.message)), "an unreadable journal must be reported, not hidden");
    agent.patchState({ journalError: null });

    // --- failed service -------------------------------------------------------------
    agent.setUnit("failed");
    instance = (await router.listInstances(options)).instances.find((entry) => entry.id === id);
    assert.strictEqual(instance.state, "Failed");
    assert.strictEqual(instance.failureReason, "PROCESS_EXITED");
    assert.strictEqual(instance.processRunning, false);

    // --- unverifiable service: Unknown, and every lifecycle action refuses -----------
    agent.setUnit("running");
    agent.patchState({ failDescribe: "SERVICE_UNIT_NOT_ALLOWED" });
    agent.clearRecords();
    instance = (await router.listInstances(options)).instances.find((entry) => entry.id === id);
    assert.strictEqual(instance.state, "Unknown", "an unreadable service must be Unknown, never Stopped");
    assert.strictEqual(instance.failureReason, "SERVICE_UNIT_NOT_ALLOWED");
    for (const [label, action] of [["start", router.startInstance], ["stop", router.stopInstance], ["restart", router.restartInstance]]) {
      const error = await expectError(action(id, options), "SERVICE_STATE_UNVERIFIED", `${label} while unverified`);
      assert.match(error.message, /could not read this service's state/i);
    }
    assert.deepStrictEqual(agent.controlCalls(), [], "no control call may be made while the state is unverified");
    agent.patchState({ failDescribe: null });

    // --- desktop dependency pre-check never gates or installs ------------------------
    const dependencyTemplate = "minecraft-vanilla";
    const templateDefinition = require("../config/marketplace-templates.json").find((template) => template.id === dependencyTemplate);
    assert.ok(templateDefinition && resolveTemplateDependencyIds(templateDefinition).length > 0,
      "test validity: the chosen template must declare dependencies, or this leg proves nothing");
    const record = JSON.parse(fs.readFileSync(agent.recordPath, "utf8"));
    fs.writeFileSync(agent.recordPath, `${JSON.stringify({ ...record, templateId: dependencyTemplate }, null, 2)}\n`);
    agent.setUnit("stopped");
    const dependencyCalls = [];
    const originalCheck = agentClient.checkDependencies;
    const originalInstall = agentClient.installDependencies;
    agentClient.checkDependencies = async (...args) => { dependencyCalls.push(["check", args]); return { ok: false, dependencies: [], missingDependencyIds: ["java"] }; };
    agentClient.installDependencies = async (...args) => { dependencyCalls.push(["install", args]); return { ok: true }; };
    try {
      agent.clearRecords();
      await router.startInstance(id, { ...options, autoInstallDependencies: true });
    } finally {
      agentClient.checkDependencies = originalCheck;
      agentClient.installDependencies = originalInstall;
    }
    assert.deepStrictEqual(dependencyCalls, [], "a service-managed start must never check or install template dependencies");
    assert.deepStrictEqual(agent.controlCalls(), [["start", agent.unit]]);

    // --- nothing above rewrote the Agent's record (other than the deliberate edit) ---
    assert.notStrictEqual(recordSha, agent.recordSha(), "sanity: the deliberate templateId edit changed the record");
    fs.writeFileSync(agent.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    assert.strictEqual(agent.recordSha(), recordSha, "restoring the record restores its exact hash");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "no child process was launched by any lifecycle operation");

    console.log("service-managed agent routing smoke passed");
  } finally {
    await agent.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
