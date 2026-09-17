#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

// V2-A/V2-G two-node drill harness (docs/v2/V2_CAMPAIGN_QUEUES.md T2, per the
// V2-G survey decomposition). Hermetic one-machine fleet drill with TWO real
// Agent processes and the desktop control-plane running in this process:
//
//   1. Spawn two agents with fully distinct runtime identities
//   2. Register both as desktop nodes (saveNode) and verify per-node health
//   3. Enroll + pair both and prove per-node credential isolation
//   4. Interrupt drill: kill agent B while node A keeps polling
//   5. Prove no cross-node results during the outage (withNodeContext stamping)
//   6. Revocation drill: delete the OFFLINE node B (honest best-effort semantics)
//   7. Recovery drill: restart B, interrupted job reconciles FAILED/JOB_INTERRUPTED
//   8. Cleanup of every spawned process and temp root
//
// HARNESS DESIGN: two CHILD PROCESSES, not in-process modules. agent/src/server.js
// is a top-level side-effect module (reads getConfig() once, starts listening at
// require time, owns process-global pairing/job/identity state), so two agents
// cannot share one process with distinct env. This is the same proven spawn +
// wait-for-health approach as agent-pairing-workflow-smoke.js and
// agent-instance-record-smoke.js. The desktop side (nodeService, serviceRouter,
// agentClient, nodeCredentialStore) runs in-process exactly like those smokes.
//
// LATER LEGS (not implementable today — append as steps 9+ here, do NOT fake
// them with stub assertions):
//   - Transfer leg: cross-node backup/file transfer between node A and node B
//     waits on the transfer-wave endpoints; add transfer + arrival assertions
//     once the API exists.
//   - Per-OS legs: one agent per OS platform (windows/linux) requires per-OS
//     fixtures or a CI matrix; this harness currently pins both agents to the
//     local platform by construction.
//   - Desktop-restart leg: a full desktop main-process restart (re-spawning the
//     Electron main) is out of scope here; the proven seam to extend is the
//     require-cache reload of the desktop service modules used by
//     agent-pairing-workflow-smoke.js after its agent restart.

const repoRoot = path.resolve(__dirname, "..");

// Pin EVERY desktop-side runtime root BEFORE requiring any src/ service module
// (test-helpers/pin-agent-roots.js). The spawned agents get explicit env roots
// per node, so the desktop pin only guards the control-plane process.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-multi-node-fleet-desktop-");

const nodeService = require("../src/services/nodeService");
const { getNodeToken } = require("../src/services/nodeCredentialStore");
const serviceRouter = require("../src/services/serviceRouter");
const { generateAgentToken, tokenFingerprint, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const INSTANCE_A_ID = "fleet-a-instance";
const INSTANCE_B_ID = "fleet-b-instance";
const INSTANCE_A_OUTAGE_ID = "fleet-a-outage-instance";
const TRANSPORT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "AGENT_TIMEOUT",
  "AGENT_UNAVAILABLE",
  "NETWORK_ERROR",
]);

function progress(step, message) {
  console.log(`[fleet ${step}] ${message}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForAgent(baseUrl) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Agent at ${baseUrl} did not become reachable.`);
}

function stopAgentProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    child.kill("SIGTERM");
    // Hard backstop so cleanup can never hang the drill.
    setTimeout(done, 8000).unref?.();
  });
}

async function agentJson(agentUrl, pathname, { token = "", method = "GET", body = null } = {}) {
  const response = await fetch(`${agentUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== null ? { "Content-Type": "application/json" } : {}),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

function readNodesJson() {
  return JSON.parse(fs.readFileSync(nodeService.getNodesPath(), "utf8"));
}

function createFleetAgent(name) {
  const agentRoot = path.join(fleetRoot, name);
  const configDir = path.join(agentRoot, "config");
  const instanceRoot = path.join(agentRoot, "instances");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(instanceRoot, { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "logs"), { recursive: true });
  // Pre-provisioned bootstrap credential (agent-enrollment-smoke makeConfig
  // pattern): a persisted shared-config token is exactly what the V2-A legacy
  // migration auto-enrolls at agent boot, so each agent starts enrolled with
  // its OWN credential before the desktop ever talks to it.
  const bootstrapToken = generateAgentToken();
  writeAgentConfigToken(path.join(configDir, "agent.json"), bootstrapToken, { backendMode: "agent" });
  return {
    name,
    agentRoot,
    configDir,
    instanceRoot,
    bootstrapToken,
    port: null,
    url: null,
    child: null,
  };
}

function spawnFleetAgent(node) {
  return spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: {
      ...process.env,
      // Distinct per node (surveyed requirement): ANXHUB_CONFIG_DIR,
      // AGENT_IDENTITY_PATH, AGENT_INSTANCE_ROOT, and AGENT_PORT are all
      // process-global in the agent, so every one of them must differ.
      ANXHUB_CONFIG_DIR: node.configDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(node.configDir, "agent.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(node.port),
      AGENT_IDENTITY_PATH: path.join(node.configDir, "identity.json"),
      AGENT_INSTANCE_ROOT: node.instanceRoot,
      AGENT_INSTANCE_EXECUTABLE_ROOTS: path.dirname(process.execPath),
      ANXOS_LOG_DIR: path.join(node.agentRoot, "logs"),
    },
    stdio: "ignore",
  });
}

function assertEnrollmentRecord(node, credential, expectedDeviceId) {
  const record = JSON.parse(fs.readFileSync(path.join(node.configDir, "enrollment.json"), "utf8"));
  assert.strictEqual(record.state, "enrolled", `${node.name} enrollment record must be enrolled.`);
  assert.strictEqual(record.tokenFingerprint, tokenFingerprint(credential), `${node.name} enrollment must bind that node's own credential.`);
  assert.strictEqual(record.nodeIdentity.deviceId, expectedDeviceId, `${node.name} enrollment must pin its own deviceId.`);
  assert.strictEqual(path.resolve(record.identityPath), path.resolve(path.join(node.configDir, "identity.json")), `${node.name} enrollment must be bound to its own identity path (multi-agent shared-config rule).`);
  assert.strictEqual(path.resolve(record.instanceRoot), path.resolve(node.instanceRoot), `${node.name} enrollment must pin its own instance root.`);
  return record;
}

let fleetRoot = null;

async function main() {
  fleetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-multi-node-fleet-agents-"));
  const agentA = createFleetAgent("agent-a");
  const agentB = createFleetAgent("agent-b");

  try {
    // --- 1. Spawn two agents with fully distinct runtime identities ---
    agentA.port = await getFreePort();
    agentB.port = await getFreePort();
    agentA.url = `http://127.0.0.1:${agentA.port}`;
    agentB.url = `http://127.0.0.1:${agentB.port}`;
    agentA.child = spawnFleetAgent(agentA);
    agentB.child = spawnFleetAgent(agentB);
    await waitForAgent(agentA.url);
    await waitForAgent(agentB.url);
    progress(1, "two agent processes are up on distinct ports");

    const healthA = await agentJson(agentA.url, "/api/v1/health");
    const healthB = await agentJson(agentB.url, "/api/v1/health");
    assert.strictEqual(healthA.status, 200, "agent A health must respond.");
    assert.strictEqual(healthB.status, 200, "agent B health must respond.");
    const deviceA = healthA.body?.identity?.deviceId;
    const deviceB = healthB.body?.identity?.deviceId;
    assert(deviceA && typeof deviceA === "string", "agent A must expose a stable deviceId.");
    assert(deviceB && typeof deviceB === "string", "agent B must expose a stable deviceId.");
    assert.notStrictEqual(deviceA, deviceB, "the two agents must have distinct device identities.");
    // V2-A multi-agent enrollment rule (enrollmentService): each agent owns its
    // binding through its own identity path, even though the machinery is built
    // to tolerate a shared config dir.
    assertEnrollmentRecord(agentA, agentA.bootstrapToken, deviceA);
    assertEnrollmentRecord(agentB, agentB.bootstrapToken, deviceB);
    progress(1, "distinct deviceIds confirmed; per-agent enrollment records bound to their own identity path");

    // --- 2. Register both as desktop nodes with distinct identities ---
    const registeredA = await nodeService.saveNode({ displayName: "Fleet Node A", agentUrl: agentA.url, agentToken: agentA.bootstrapToken });
    const registeredB = await nodeService.saveNode({ displayName: "Fleet Node B", agentUrl: agentB.url, agentToken: agentB.bootstrapToken });
    const nodeA = registeredA.node;
    const nodeB = registeredB.node;
    assert.strictEqual(nodeA.id, `agent-${deviceA}`, "node A id must derive from agent A's deviceId.");
    assert.strictEqual(nodeB.id, `agent-${deviceB}`, "node B id must derive from agent B's deviceId.");
    assert.notStrictEqual(nodeA.id, nodeB.id, "the two registered nodes must have distinct ids.");
    assert.notStrictEqual(nodeA.agentIdentity.deviceId, nodeB.agentIdentity.deviceId, "registered nodes must carry distinct deviceIds.");
    const healthAAfterSave = await nodeService.checkNodeHealth(nodeA.id);
    const healthBAfterSave = await nodeService.checkNodeHealth(nodeB.id);
    assert.strictEqual(healthAAfterSave.state, "online", "node A must be healthy right after registration.");
    assert.strictEqual(healthBAfterSave.state, "online", "node B must be healthy right after registration.");
    assert.strictEqual(getNodeToken(nodeA.id), agentA.bootstrapToken, "node A must store its own credential.");
    assert.strictEqual(getNodeToken(nodeB.id), agentB.bootstrapToken, "node B must store its own credential.");
    progress(2, "both nodes registered, distinct deviceIds, both healthy");

    // --- 3. Enroll + pair both; prove per-node credential isolation ---
    const pairA = await agentJson(agentA.url, "/api/v1/pairing/start", { method: "POST", body: {} });
    assert.strictEqual(pairA.status, 200, "agent A must open a pairing session.");
    const pairedA = await nodeService.pairNodeFromCode({ pairingCode: pairA.body.pairingCode });
    assert.strictEqual(pairedA.node.id, nodeA.id, "pairing must re-pair the already-registered node A in place.");
    const credentialA = nodeService.getNodeAgentConfig(nodeA.id).agentToken;
    assert.notStrictEqual(credentialA, agentA.bootstrapToken, "pairing node A must rotate its credential.");
    const enrollStartA = await agentJson(agentA.url, "/api/v1/enroll/start", { method: "POST", body: { minProtocolVersion: 1, maxProtocolVersion: 1 } });
    assert.strictEqual(enrollStartA.status, 200, "agent A must start an enrollment handshake.");
    const enrollCompleteA = await agentJson(agentA.url, "/api/v1/enroll/complete", {
      method: "POST",
      body: { enrollNonce: enrollStartA.body.enrollNonce, agentToken: credentialA, agentUrl: agentA.url },
    });
    assert.strictEqual(enrollCompleteA.status, 200, "agent A must complete enrollment with node A's credential.");
    assert.strictEqual(enrollCompleteA.body.tokenFingerprint, tokenFingerprint(credentialA), "enrollment must bind node A's active credential.");
    assert.strictEqual(enrollCompleteA.body.identity.deviceId, deviceA, "enrollment must bind agent A's own identity.");
    assert(enrollCompleteA.body.enrollmentId.startsWith("enr-"), "enrollment must mint an enrollmentId.");

    const pairB = await agentJson(agentB.url, "/api/v1/pairing/start", { method: "POST", body: {} });
    assert.strictEqual(pairB.status, 200, "agent B must open a pairing session.");
    const pairedB = await nodeService.pairNodeFromCode({ pairingCode: pairB.body.pairingCode });
    assert.strictEqual(pairedB.node.id, nodeB.id, "pairing must re-pair the already-registered node B in place.");
    const credentialB = nodeService.getNodeAgentConfig(nodeB.id).agentToken;
    assert.notStrictEqual(credentialB, agentB.bootstrapToken, "pairing node B must rotate its credential.");
    const enrollStartB = await agentJson(agentB.url, "/api/v1/enroll/start", { method: "POST", body: { minProtocolVersion: 1, maxProtocolVersion: 1 } });
    assert.strictEqual(enrollStartB.status, 200, "agent B must start an enrollment handshake.");
    const enrollCompleteB = await agentJson(agentB.url, "/api/v1/enroll/complete", {
      method: "POST",
      body: { enrollNonce: enrollStartB.body.enrollNonce, agentToken: credentialB, agentUrl: agentB.url },
    });
    assert.strictEqual(enrollCompleteB.status, 200, "agent B must complete enrollment with node B's credential.");
    assert.strictEqual(enrollCompleteB.body.tokenFingerprint, tokenFingerprint(credentialB), "enrollment must bind node B's active credential.");
    const recordA = assertEnrollmentRecord(agentA, credentialA, deviceA);
    const recordB = assertEnrollmentRecord(agentB, credentialB, deviceB);
    assert.notStrictEqual(recordA.tokenFingerprint, recordB.tokenFingerprint, "the two agents must hold isolated enrollment bindings.");
    // Credential isolation: node A's token must NOT authenticate against agent B
    // and vice versa (cross-node use of a paired/enrolled credential is a 401).
    const crossUseAB = await agentJson(agentB.url, "/api/v1/instances", { token: credentialA });
    assert(crossUseAB.status === 401 || crossUseAB.status === 403, "node A's credential must be refused by agent B.");
    const crossUseBA = await agentJson(agentA.url, "/api/v1/instances", { token: credentialB });
    assert(crossUseBA.status === 401 || crossUseBA.status === 403, "node B's credential must be refused by agent A.");
    assert(!JSON.stringify(recordA).includes(recordB.tokenFingerprint), "agent A's enrollment record must not carry agent B's credential fingerprint.");
    progress(3, "both agents enrolled and paired; per-node credentials isolated in both directions");

    // --- 4. Interrupt drill: kill agent B while node A keeps polling ---
    // Seed the workload picture first: one instance per node, created through
    // the node's own credential.
    const createdA = await serviceRouter.createInstance({ nodeId: nodeA.id, id: INSTANCE_A_ID, displayName: "Fleet A Instance", type: "custom-command", executable: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"] });
    assert.strictEqual(createdA?.instance?.id, INSTANCE_A_ID, "instance creation through node A routing must succeed.");
    const createdB = await agentJson(agentB.url, "/api/v1/instances", { token: credentialB, method: "POST", body: { id: INSTANCE_B_ID, displayName: "Fleet B Instance", type: "custom-command", executable: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"] } });
    assert.strictEqual(createdB.status, 201, "instance creation on agent B must succeed.");

    // A job in flight on B at kill time: B had persisted its durable record and
    // died before settling it. The record format below is exactly what the V2-A
    // job engine persists mid-flight (clone of the disk-written mid-flight
    // record used by scripts/instance-job-reobservation-smoke.js). The target
    // instance stays Stopped, so boot-time re-observation must reconcile the
    // start job to FAILED/JOB_INTERRUPTED instead of guessing a success.
    const seededJobId = `job_${crypto.randomBytes(16).toString("hex")}`;
    fs.mkdirSync(path.join(agentB.instanceRoot, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(agentB.instanceRoot, "jobs", `${seededJobId}.json`), `${JSON.stringify({
      id: seededJobId,
      idempotencyKey: null,
      type: "instance.start",
      target: { instanceId: INSTANCE_B_ID },
      owner: { actorId: null, role: null },
      state: "running",
      stage: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      timeoutMs: 600000,
      attempts: 1,
      exitCode: null,
      error: null,
      result: null,
      cancellation: { requestedAt: null, reason: null, supported: false },
      events: [],
    }, null, 2)}\n`, { mode: 0o600 });

    await stopAgentProcess(agentB.child);
    agentB.child = null;
    progress(4, "agent B process killed; node A keeps polling");

    let outageHealthA = null;
    for (let round = 1; round <= 2; round += 1) {
      outageHealthA = await nodeService.checkNodeHealth(nodeA.id);
      assert.strictEqual(outageHealthA.state, "online", `node A must stay online during outage polling round ${round}.`);
      assert.strictEqual(outageHealthA.nodeId, nodeA.id, "node A health result must carry node A's id.");
      const listedDuringOutage = await serviceRouter.listInstances({ nodeId: nodeA.id });
      assert(Array.isArray(listedDuringOutage.instances), "node A instance list must keep working during the outage.");
      assert(listedDuringOutage.instances.some((instance) => instance.id === INSTANCE_A_ID), "node A must still report its own instance during the outage.");
    }
    const outageWrite = await serviceRouter.createInstance({ nodeId: nodeA.id, id: INSTANCE_A_OUTAGE_ID, displayName: "Fleet A Outage Instance", type: "custom-command", executable: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"] });
    assert.strictEqual(outageWrite?.instance?.id, INSTANCE_A_OUTAGE_ID, "an instance write on node A must succeed while agent B is down.");
    const healthBOutage = await nodeService.checkNodeHealth(nodeB.id);
    assert.strictEqual(healthBOutage.state, "offline", "node B must report offline while its agent is down.");
    assert.strictEqual(healthBOutage.connected, false, "node B must not be connected while its agent is down.");
    await assert.rejects(
      () => serviceRouter.listInstances({ nodeId: nodeB.id }),
      (error) => TRANSPORT_FAILURE_CODES.has(error?.code || error?.payload?.error?.code),
      "operations routed at the down node must fail with an honest transport error.",
    );
    progress(4, "node A fully usable (health, instance read, instance write); node B offline");

    // --- 5. No cross-node results during the outage ---
    // Every response captured while B is down must be stamped with node A's id
    // (serviceRouter withNodeContext) and must never carry node B's data.
    const stampedBackups = await serviceRouter.listBackups({ nodeId: nodeA.id });
    assert.strictEqual(stampedBackups.nodeId, nodeA.id, "stamped responses during the outage must carry node A's nodeId.");
    assert(Array.isArray(stampedBackups.backups), "the stamped backup listing must keep its shape.");
    assert(stampedBackups.backups.every((backup) => backup.nodeId === nodeA.id), "every stamped entry during the outage must belong to node A.");
    const outageCapture = [outageHealthA, stampedBackups, outageWrite];
    const captureText = JSON.stringify(outageCapture);
    assert(!captureText.includes(INSTANCE_B_ID), "node A responses during the outage must never contain node B's instance data.");
    assert(!captureText.includes(seededJobId), "node A responses during the outage must never contain agent B's job records.");
    assert(!captureText.includes(nodeB.id), "node A responses during the outage must never be stamped with node B's id.");
    progress(5, "no cross-node results: node A responses stamped with its own nodeId and free of node B data");

    // --- 6. Revocation drill: delete the OFFLINE node B ---
    // The landed node lifecycle is best-effort: revocation is attempted through
    // B's own credential, fails honestly because B is unreachable, and the
    // local record is removed anyway with the failure surfaced in revocation.code.
    const deleteB = await nodeService.deleteNode(nodeB.id, { timeoutMs: 2000 });
    assert.strictEqual(deleteB.deleted, true, "deleting the offline node must still succeed locally.");
    assert.strictEqual(deleteB.revocation.attempted, true, "revocation must be attempted for a node with an Agent URL.");
    assert.strictEqual(deleteB.revocation.revoked, false, "revocation against a down agent must NOT be reported as revoked.");
    assert(TRANSPORT_FAILURE_CODES.has(deleteB.revocation.code), `the offline revocation failure must surface a timeout/connection error code, got ${deleteB.revocation.code}.`);
    assert(typeof deleteB.revocation.reason === "string" && deleteB.revocation.reason.length > 0, "the offline revocation failure must surface a reason.");
    assert(readNodesJson().nodes.every((node) => node.id !== nodeB.id), "the offline node's local record must be removed.");
    assert.strictEqual(getNodeToken(nodeB.id), "", "the offline node's stored credential must be deleted with the record.");
    const healthADuringRevocation = await nodeService.checkNodeHealth(nodeA.id);
    assert.strictEqual(healthADuringRevocation.state, "online", "node A must be unaffected by node B's deletion.");
    progress(6, "offline delete: revocation honestly failed (transport code surfaced), local record removed");

    // --- 7. Recovery drill: restart agent B with the same roots ---
    // B's enrollment was NOT revoked (the desktop could not reach it), so its
    // last credential must still authenticate after the restart, and the job
    // that was in flight at kill time must reconcile to FAILED/JOB_INTERRUPTED
    // during B's boot (recoverInterruptedJobs).
    agentB.child = spawnFleetAgent(agentB);
    await waitForAgent(agentB.url);
    const jobAfterRecovery = await agentJson(agentB.url, `/api/v1/jobs/${seededJobId}`, { token: credentialB });
    assert.strictEqual(jobAfterRecovery.status, 200, "agent B must expose the durable job record after recovery.");
    assert.strictEqual(jobAfterRecovery.body.job.state, "failed", "the interrupted start job must reconcile to failed.");
    assert.strictEqual(jobAfterRecovery.body.job.error.code, "JOB_INTERRUPTED", "the reconciled job must carry the JOB_INTERRUPTED error code.");
    assert(jobAfterRecovery.body.job.events.some((event) => event.action === "job.reobserved" && event.detail?.reconciledTo === "failed"), "the interrupted job must carry a job.reobserved re-observation event.");
    const jobsForInstance = await agentJson(agentB.url, `/api/v1/jobs?instanceId=${INSTANCE_B_ID}`, { token: credentialB });
    // Two records reference B's instance: the job-wrapped instance.create B
    // executed through its own engine (succeeded) and the interrupted start.
    assert.strictEqual(jobsForInstance.body.total, 2, "only the instance.create job and the interrupted start job may reference B's instance.");
    const jobsByType = new Map(jobsForInstance.body.jobs.map((job) => [job.type, job]));
    assert.strictEqual(jobsByType.get("instance.create")?.state, "succeeded", "agent B's own create job must have settled successfully before the crash.");
    assert.strictEqual(jobsByType.get("instance.start")?.state, "failed", "the interrupted start job must be the failed one.");
    progress(7, "agent B rebooted: in-flight job reconciled to FAILED/JOB_INTERRUPTED with a re-observation event");

    // Honest offline-delete semantics: B was down when the desktop deleted the
    // node, revocation failed, so B's OLD credential is still valid after the
    // restart (pinned current behavior — a later wave may change this; update
    // this assertion deliberately when it does).
    const oldTokenAfterRecovery = await agentJson(agentB.url, "/api/v1/instances", { token: credentialB });
    assert.strictEqual(oldTokenAfterRecovery.status, 200, "the pre-delete credential must still authenticate because revocation failed while B was down.");
    assert(oldTokenAfterRecovery.body.instances.some((instance) => instance.id === INSTANCE_B_ID), "the restarted agent B must still serve its own instance.");
    const statusAfterRecovery = await agentJson(agentB.url, "/api/v1/enroll/status");
    assert.strictEqual(statusAfterRecovery.body.state, "enrolled", "agent B's enrollment must survive an offline delete.");

    // Node B rejoins through the normal pairing flow and health recovers.
    const rejoinPairing = await agentJson(agentB.url, "/api/v1/pairing/start", { method: "POST", body: {} });
    assert.strictEqual(rejoinPairing.status, 200, "restarted agent B must offer a fresh pairing session.");
    const rejoined = await nodeService.pairNodeFromCode({ pairingCode: rejoinPairing.body.pairingCode });
    assert.strictEqual(rejoined.node.id, nodeB.id, "node B must rejoin under the same node id (id derives from the unchanged deviceId).");
    const rotatedCredentialB = nodeService.getNodeAgentConfig(nodeB.id).agentToken;
    assert.notStrictEqual(rotatedCredentialB, credentialB, "rejoining must rotate node B's credential.");
    const healthBRejoined = await nodeService.checkNodeHealth(nodeB.id);
    assert.strictEqual(healthBRejoined.state, "online", "node B health must recover after rejoining.");
    const rejoinedList = await serviceRouter.listInstances({ nodeId: nodeB.id });
    assert(rejoinedList.instances.some((instance) => instance.id === INSTANCE_B_ID), "node B must serve its own instances after rejoining.");
    const staleTokenAfterRejoin = await agentJson(agentB.url, "/api/v1/instances", { token: credentialB });
    assert.strictEqual(staleTokenAfterRejoin.status, 401, "the pre-rejoin credential must be rejected after pairing rotated it.");
    const healthAFinal = await nodeService.checkNodeHealth(nodeA.id);
    assert.strictEqual(healthAFinal.state, "online", "node A must still be online at the end of the drill.");
    progress(7, "node B rejoined (same node id), health recovered, credential rotated, node A unaffected");

    console.log("multi-node-fleet-smoke passed");
  } finally {
    // --- 8. Cleanup: every spawned process and temp root ---
    await stopAgentProcess(agentA.child);
    await stopAgentProcess(agentB.child);
    if (fleetRoot) {
      try { fs.rmSync(fleetRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((error) => {
  console.error("multi-node-fleet-smoke FAILED:", error);
  process.exitCode = 1;
});
