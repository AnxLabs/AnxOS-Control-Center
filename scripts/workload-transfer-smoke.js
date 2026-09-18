#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const { spawn } = require("child_process");

// V2-G Wave 4: the multi-node-fleet-smoke "LATER LEGS" transfer leg. Hermetic
// one-machine drill with TWO real Agent processes (distinct roots, ports, and
// identities — clone of the proven fleet-harness spawn + register + pair
// sections) and the desktop control plane running in this process:
//
//   1. Spawn two agents, register both as desktop nodes, pair both
//   2. Create an instance plus workload data on agent A
//   3. Preview leg: transferWorkload A->B without confirm stops after the
//      target restore preview, surfaces the verdict, and cleans up the
//      target-side imported archive (conflict refusal without confirm)
//   4. Confirmed leg: transferWorkload A->B with confirmOverwrite reusing the
//      preview's backup; B receives the workload byte-identical, A untouched
//   5. Negative routing: same-node and unknown-node refusals with step trails
//   6. IPC: workload channels are permission-gated before the service runs,
//      authorized calls reach the service with per-step audits, and failed
//      transfers keep their step trail on the error
//   7. Cleanup of every spawned process and temp root
//
// The transfer rides only existing Agent endpoints (createBackup, download,
// import, restore preview/confirm) orchestrated desktop-side by
// src/services/workloadTransferService.js.

const repoRoot = path.resolve(__dirname, "..");

// Pin EVERY desktop-side runtime root BEFORE requiring any src/ service module
// (test-helpers/pin-agent-roots.js). The spawned agents get explicit env roots
// per node, so the desktop pin only guards the control-plane process.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-workload-transfer-desktop-");

const nodeService = require("../src/services/nodeService");
const serviceRouter = require("../src/services/serviceRouter");
const workloadTransferService = require("../src/services/workloadTransferService");
const { getNodeToken } = require("../src/services/nodeCredentialStore");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const INSTANCE_ID = "transfer-instance";
const INSTANCE_DISPLAY_NAME = "Workload Transfer Source";

function progress(step, message) {
  console.log(`[transfer ${step}] ${message}`);
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

let transferRoot = null;

function createTransferAgent(name) {
  const agentRoot = path.join(transferRoot, name);
  const configDir = path.join(agentRoot, "config");
  const instanceRoot = path.join(agentRoot, "instances");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(instanceRoot, { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "logs"), { recursive: true });
  // Pre-provisioned bootstrap credential (agent-enrollment-smoke makeConfig
  // pattern, shared with the fleet harness): the persisted shared-config token
  // is what the agent auto-enrolls at boot.
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

function spawnTransferAgent(node) {
  return spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: {
      ...process.env,
      // Distinct per node: ANXHUB_CONFIG_DIR, AGENT_IDENTITY_PATH,
      // AGENT_INSTANCE_ROOT, and AGENT_PORT are all process-global in the
      // agent, so every one of them must differ (fleet-harness rule).
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

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotTree(rootDir) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.set(path.relative(rootDir, fullPath).split(path.sep).join("/"), sha256Buffer(fs.readFileSync(fullPath)));
      }
    }
  };
  walk(rootDir);
  return files;
}

function assertStepNames(result, expectedNames, label) {
  const names = result.steps.map((step) => step.step);
  assert.deepStrictEqual(names, expectedNames, `${label} must record its steps in order.`);
  assert(result.steps.every((step) => step.ok === true), `${label} steps must all be ok.`);
}

async function main() {
  transferRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-workload-transfer-agents-"));
  const agentA = createTransferAgent("agent-a");
  const agentB = createTransferAgent("agent-b");

  try {
    // --- 1. Spawn two agents, register and pair both ---
    agentA.port = await getFreePort();
    agentB.port = await getFreePort();
    agentA.url = `http://127.0.0.1:${agentA.port}`;
    agentB.url = `http://127.0.0.1:${agentB.port}`;
    agentA.child = spawnTransferAgent(agentA);
    agentB.child = spawnTransferAgent(agentB);
    await waitForAgent(agentA.url);
    await waitForAgent(agentB.url);
    const deviceA = (await agentJson(agentA.url, "/api/v1/health")).body?.identity?.deviceId;
    const deviceB = (await agentJson(agentB.url, "/api/v1/health")).body?.identity?.deviceId;
    assert(deviceA && deviceB && deviceA !== deviceB, "the two agents must expose distinct device identities.");

    const registeredA = await nodeService.saveNode({ displayName: "Transfer Node A", agentUrl: agentA.url, agentToken: agentA.bootstrapToken });
    const registeredB = await nodeService.saveNode({ displayName: "Transfer Node B", agentUrl: agentB.url, agentToken: agentB.bootstrapToken });
    const nodeA = registeredA.node;
    const nodeB = registeredB.node;
    assert.strictEqual(nodeA.id, `agent-${deviceA}`, "node A id must derive from agent A's deviceId.");
    assert.strictEqual(nodeB.id, `agent-${deviceB}`, "node B id must derive from agent B's deviceId.");
    // Pair both (rotates each node's credential) exactly like the fleet
    // harness so every later service call uses an enrolled credential.
    const pairA = await agentJson(agentA.url, "/api/v1/pairing/start", { method: "POST", body: {} });
    assert.strictEqual(pairA.status, 200, "agent A must open a pairing session.");
    const pairedA = await nodeService.pairNodeFromCode({ pairingCode: pairA.body.pairingCode });
    assert.strictEqual(pairedA.node.id, nodeA.id, "pairing must re-pair node A in place.");
    const credentialA = nodeService.getNodeAgentConfig(nodeA.id).agentToken;
    const pairB = await agentJson(agentB.url, "/api/v1/pairing/start", { method: "POST", body: {} });
    assert.strictEqual(pairB.status, 200, "agent B must open a pairing session.");
    const pairedB = await nodeService.pairNodeFromCode({ pairingCode: pairB.body.pairingCode });
    assert.strictEqual(pairedB.node.id, nodeB.id, "pairing must re-pair node B in place.");
    const credentialB = nodeService.getNodeAgentConfig(nodeB.id).agentToken;
    assert.notStrictEqual(credentialA, agentA.bootstrapToken, "pairing node A must rotate its credential.");
    assert.notStrictEqual(credentialB, agentB.bootstrapToken, "pairing node B must rotate its credential.");
    assert.strictEqual(getNodeToken(nodeA.id), credentialA, "node A must store its own rotated credential.");
    assert.strictEqual(getNodeToken(nodeB.id), credentialB, "node B must store its own rotated credential.");
    progress(1, "two agents up, registered and paired with distinct identities");

    // --- 2. Create an instance plus workload data on agent A ---
    const createdA = await serviceRouter.createInstance({ nodeId: nodeA.id, id: INSTANCE_ID, displayName: INSTANCE_DISPLAY_NAME, type: "custom-command", executable: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"] });
    assert.strictEqual(createdA?.instance?.id, INSTANCE_ID, "instance creation through node A routing must succeed.");
    // Seed workload data through the agent's own filesystem (the desktop-side
    // file API is exercised elsewhere; the transfer leg asserts data motion).
    const instanceDirA = path.join(agentA.instanceRoot, INSTANCE_ID);
    fs.mkdirSync(path.join(instanceDirA, "data", "world"), { recursive: true });
    fs.mkdirSync(path.join(instanceDirA, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(instanceDirA, "data", "world", "level.dat"), `${INSTANCE_ID}-level-${"x".repeat(256)}`);
    fs.writeFileSync(path.join(instanceDirA, "data", "world", "session.lock"), "transfer-session-lock");
    fs.writeFileSync(path.join(instanceDirA, "plugins", "README.txt"), "workload-transfer-fixture");
    const listedA = await serviceRouter.listInstances({ nodeId: nodeA.id });
    const instanceARecord = listedA.instances.find((instance) => instance.id === INSTANCE_ID);
    assert(instanceARecord, "node A must report the seeded instance.");
    // Baseline taken after the agent's own record normalization (the instance
    // list backfills config.json), so the untouched assertions below cover the
    // transfer itself, not agent-side record maintenance.
    const beforeTransfer = snapshotTree(instanceDirA);
    assert(beforeTransfer.get("data/world/level.dat"), "fixture check: the seeded workload data must exist on A.");
    progress(2, `instance ${INSTANCE_ID} and workload data seeded on node A`);

    // --- 3. Preview leg: no confirm -> verdict surfaced, nothing destructive,
    // imported archive cleaned up on B ---
    const previewResult = await workloadTransferService.transferWorkload({
      sourceNodeId: nodeA.id,
      targetNodeId: nodeB.id,
      instanceId: INSTANCE_ID,
      confirmOverwrite: false,
    });
    assert.strictEqual(previewResult.ok, true, "the preview leg must succeed up to the verdict.");
    assert.strictEqual(previewResult.requiresConfirmation, true, "without confirmOverwrite the transfer must stop for confirmation.");
    assert.strictEqual(previewResult.confirmed, false, "the preview leg must not run the destructive phase.");
    assert.strictEqual(previewResult.verdict, "overwrite", "a same-id registered target must surface the overwrite verdict.");
    assert.strictEqual(previewResult.conflict.requiresConfirmation, true, "the surfaced conflict must demand confirmation.");
    assert.deepStrictEqual(previewResult.conflict.warnings, [], "a stopped same-id target must produce no preview warnings.");
    assert(previewResult.backupId, "the preview leg must report the source-side backup id.");
    assert.strictEqual(previewResult.importedBackupCleanedUp, true, "the unconsumed imported archive must be cleaned up.");
    assertStepNames(
      previewResult,
      ["resolve.nodes", "source.backup", "source.download", "target.import", "target.instance.ensure", "target.restore.preview", "target.import.cleanup", "target.instance.cleanup"],
      "the preview leg",
    );
    assert.strictEqual(previewResult.steps.find((step) => step.step === "target.instance.ensure").created, true, "the preview leg must register the placeholder target instance.");
    assert.strictEqual(previewResult.steps.find((step) => step.step === "target.import.cleanup").reason, "confirmation-required", "the cleanup must be recorded with its reason.");
    assert.strictEqual(previewResult.steps.find((step) => step.step === "target.instance.cleanup").deleted, true, "a declined transfer must clean up the placeholder it created.");
    // Nothing destructive happened on B: the workload data never arrived (the
    // placeholder scaffolding may exist, but none of A's files do), and the
    // imported archive is gone again.
    assert(!fs.existsSync(path.join(agentB.instanceRoot, INSTANCE_ID, "data", "world", "level.dat")), "the preview leg must not move workload data to the target.");
    const backupsOnBAfterPreview = (await serviceRouter.listBackups({ nodeId: nodeB.id })).backups;
    assert.strictEqual(backupsOnBAfterPreview.length, 0, "the target must not keep the imported archive after the preview stop.");
    // The source is untouched by the preview leg (its new backup is a
    // legitimate source-side artifact, not instance data).
    assert.deepStrictEqual(snapshotTree(instanceDirA), beforeTransfer, "node A's workload must be untouched by the preview leg.");
    progress(3, "preview leg: overwrite verdict surfaced, target placeholder registered, imported archive cleaned up");

    // --- 3b. P0 regression (adversarial audit): a declined preview against a
    // target that ALREADY EXISTED must never delete that instance. Seed a
    // distinct pre-existing instance on B, preview a transfer onto it, and
    // assert it survives with its data intact.
    const PREEXISTING_ID = "preexisting-target";
    const preexistingDir = path.join(agentB.instanceRoot, PREEXISTING_ID);
    fs.mkdirSync(path.join(preexistingDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(preexistingDir, "config.json"), JSON.stringify({ id: PREEXISTING_ID, state: "Stopped" }), { mode: 0o600 });
    fs.writeFileSync(path.join(preexistingDir, "data", "sentinel.bin"), "do-not-delete");
    const preexistingBefore = snapshotTree(preexistingDir);
    const preexistingPreview = await workloadTransferService.transferWorkload({
      sourceNodeId: nodeA.id,
      targetNodeId: nodeB.id,
      backupId: previewResult.backupId,
      targetInstanceId: PREEXISTING_ID,
      confirmOverwrite: false,
    });
    assert.strictEqual(preexistingPreview.requiresConfirmation, true, "the pre-existing-target preview must stop for confirmation.");
    const ensureStep = preexistingPreview.steps.find((step) => step.step === "target.instance.ensure");
    assert.strictEqual(ensureStep.created, false, "the pre-existing target must not be treated as a created placeholder.");
    assert(!preexistingPreview.steps.some((step) => step.step === "target.instance.cleanup"),
      "a declined preview against a PRE-EXISTING target must not run placeholder cleanup at all.");
    assert(fs.existsSync(preexistingDir), "a declined preview must never delete a pre-existing target instance.");
    // The agent's own status/record normalization may rewrite config.json
    // (the same maintenance the smoke's transfer baseline already accounts
    // for), so the invariant pinned here is the one that matters: the
    // instance survives, its workload data is untouched, and its identity
    // is unchanged.
    assert.strictEqual(fs.readFileSync(path.join(preexistingDir, "data", "sentinel.bin"), "utf8"), "do-not-delete",
      "a declined preview must leave the pre-existing target's data byte-identical.");
    assert.strictEqual(snapshotTree(preexistingDir).get("data/sentinel.bin"), preexistingBefore.get("data/sentinel.bin"),
      "the pre-existing target's payload must be byte-identical after a declined preview.");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(preexistingDir, "config.json"), "utf8")).id, PREEXISTING_ID,
      "the pre-existing target must keep its own identity after a declined preview.");
    progress(3, `P0 regression pinned: declined preview left pre-existing target ${PREEXISTING_ID} intact`);

    // --- 4. Confirmed leg: reuse the preview's backup, confirm the restore ---
    const confirmedResult = await workloadTransferService.transferWorkload({
      sourceNodeId: nodeA.id,
      targetNodeId: nodeB.id,
      backupId: previewResult.backupId,
      confirmOverwrite: true,
    });
    assert.strictEqual(confirmedResult.ok, true, "the confirmed transfer must succeed.");
    assert.strictEqual(confirmedResult.confirmed, true, "the confirmed leg must run the destructive phase.");
    assert.strictEqual(confirmedResult.requiresConfirmation, false, "a confirmed transfer must not ask again.");
    assert.strictEqual(confirmedResult.verdict, "overwrite", "the surfaced verdict must stay the overwrite verdict.");
    assert.strictEqual(confirmedResult.backupId, previewResult.backupId, "the confirmed leg must reuse the preview's source backup.");
    assert.strictEqual(confirmedResult.restore.targetInstanceId, INSTANCE_ID, "the restore must target the transferred instance id.");
    assert(confirmedResult.restore.safetyBackupId, "the confirmed restore must take a target-side safety snapshot.");
    assert(confirmedResult.importedBackupId, "the consumed imported archive id must stay reported.");
    assert.strictEqual(confirmedResult.importedBackupConsumed, true, "the confirmed restore must consume the imported archive.");
    const confirmedStepNames = confirmedResult.steps.map((step) => step.step);
    assert(confirmedStepNames.includes("target.restore.confirm"), "the confirmed leg must record the confirm step.");
    assert(!confirmedStepNames.includes("target.import.cleanup"), "a consumed imported archive must not be cleaned up.");
    assert(confirmedResult.steps.every((step) => step.ok === true), "the confirmed leg steps must all be ok.");
    // Byte-identical arrival: B's instance directory now equals A's seeded
    // workload (same-id transfer keeps the archive's own record untouched).
    assert.deepStrictEqual(snapshotTree(path.join(agentB.instanceRoot, INSTANCE_ID)), beforeTransfer, "the transferred workload must be byte-identical on node B.");
    const listedB = await serviceRouter.listInstances({ nodeId: nodeB.id });
    const instanceBRecord = listedB.instances.find((instance) => instance.id === INSTANCE_ID);
    assert(instanceBRecord, "node B must report the transferred instance.");
    assert.strictEqual(instanceBRecord.displayName, INSTANCE_DISPLAY_NAME, "the transferred instance must carry the source workload's display name.");
    // The source stayed byte-identical across both legs.
    assert.deepStrictEqual(snapshotTree(instanceDirA), beforeTransfer, "node A's workload must remain untouched by the confirmed transfer.");
    const stillListedA = await serviceRouter.listInstances({ nodeId: nodeA.id });
    assert(stillListedA.instances.some((instance) => instance.id === INSTANCE_ID), "node A must keep serving its own instance after the transfer.");
    // The transferred instance id must match A's credential-free record on B's
    // own API, proving the data really crossed nodes under B's credential.
    const transferredOnB = await agentJson(agentB.url, `/api/v1/instances/${INSTANCE_ID}/status`, { token: credentialB });
    assert.strictEqual(transferredOnB.status, 200, "agent B must serve the transferred instance through its own credential.");
    progress(4, "confirmed leg: workload byte-identical on B, source untouched, imported archive consumed");

    // --- 5. Negative routing refusals with honest step trails ---
    const backupIdsOnBBeforeRefusals = (await serviceRouter.listBackups({ nodeId: nodeB.id })).backups.map((backup) => backup.id).sort();
    await assert.rejects(
      () => workloadTransferService.transferWorkload({ sourceNodeId: nodeA.id, targetNodeId: nodeA.id, instanceId: INSTANCE_ID }),
      (error) => error?.code === "TRANSFER_NODES_IDENTICAL" && Array.isArray(error?.details?.steps),
      "a same-node transfer must be refused with its step trail.",
    );
    await assert.rejects(
      () => workloadTransferService.transferWorkload({ sourceNodeId: "agent-does-not-exist", targetNodeId: nodeB.id, instanceId: INSTANCE_ID }),
      (error) => error?.code === "NODE_NOT_FOUND" && error?.details?.steps.some((step) => step.step === "resolve.nodes" && step.ok === false),
      "an unknown source node must be refused with a failed resolve step.",
    );
    const backupIdsOnBAfterRefusals = (await serviceRouter.listBackups({ nodeId: nodeB.id })).backups.map((backup) => backup.id).sort();
    assert.deepStrictEqual(backupIdsOnBAfterRefusals, backupIdsOnBBeforeRefusals, "refused transfers must not change the target's backup store (the consumed transfer archive stays retained).");
    progress(5, "negative routing: same-node and unknown-node refusals carry step trails");

    // --- 6. IPC: authorization gates before the service, per-step audits ---
    const handlers = new Map();
    const auditEvents = [];
    const transferCalls = [];
    let ownerGate = true;
    let permissionGate = true;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "electron") {
        return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
      }
      if (request === "../services/securityService") {
        return {
          audit: (event) => auditEvents.push(event),
          requireLocalOwnerAuthenticated: () => {
            if (ownerGate) {
              throw Object.assign(new Error("Unlock AnxOS to continue."), { code: "AUTH_UNLOCK_REQUIRED" });
            }
          },
          requirePermission: () => {
            if (permissionGate) {
              throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" });
            }
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      require("../src/ipc/workloadIpc").registerWorkloadIpc();
    } finally {
      Module._load = originalLoad;
    }
    assert(handlers.get("workload:transferPreview"), "workload:transferPreview must be registered.");
    assert(handlers.get("workload:transfer"), "workload:transfer must be registered.");

    const transferPayload = { sourceNodeId: nodeA.id, targetNodeId: nodeB.id, instanceId: INSTANCE_ID };
    await assert.rejects(
      () => handlers.get("workload:transfer")({}, transferPayload),
      (error) => error?.code === "AUTH_UNLOCK_REQUIRED",
      "workload:transfer must demand an unlocked local owner before anything else.",
    );
    ownerGate = false;
    await assert.rejects(
      () => handlers.get("workload:transfer")({}, transferPayload),
      (error) => error?.code === "PERMISSION_DENIED",
      "workload:transfer must reject a renderer without the fleet write tier.",
    );
    await assert.rejects(
      () => handlers.get("workload:transferPreview")({}, transferPayload),
      (error) => error?.code === "PERMISSION_DENIED",
      "workload:transferPreview must reject a renderer without the read tier.",
    );
    assert.strictEqual(transferCalls.length, 0, "unauthorized workload channels must not reach the transfer service.");
    assert.strictEqual(auditEvents.length, 0, "unauthorized workload channels must not audit a transfer.");

    // Authorized path: the service is stubbed so the channel wiring, the
    // per-step audit entries, and the error contract are pinned without a
    // third live transfer.
    permissionGate = false;
    workloadTransferService.transferWorkload = async (payload) => {
      transferCalls.push(payload);
      return {
        ok: true,
        confirmed: true,
        sourceNodeId: payload.sourceNodeId,
        targetNodeId: payload.targetNodeId,
        steps: [
          { step: "resolve.nodes", ok: true },
          { step: "target.restore.confirm", ok: true },
        ],
      };
    };
    const authorized = await handlers.get("workload:transfer")({}, transferPayload);
    assert.strictEqual(authorized.ok, true, "an authorized workload:transfer must reach the service.");
    assert.strictEqual(transferCalls.length, 1, "an authorized workload:transfer must invoke the transfer service.");
    await handlers.get("workload:transferPreview")({}, transferPayload);
    assert.strictEqual(transferCalls.length, 2, "an authorized workload:transferPreview must reach the service.");
    assert.strictEqual(transferCalls[1].confirmOverwrite, false, "the preview channel must always force confirmOverwrite off.");
    const stepAudits = auditEvents.filter((event) => String(event.action).startsWith("workload.transfer."));
    // Both channels audit their step trails now (review P1-5): the confirmed
    // leg and the preview channel (which runs the same write-tier pipeline)
    // each mirror their result steps.
    assert.deepStrictEqual(stepAudits.map((event) => event.action), [
      "workload.transfer.resolve.nodes",
      "workload.transfer.target.restore.confirm",
      "workload.transfer.resolve.nodes",
      "workload.transfer.target.restore.confirm",
    ], "per-step audit entries must mirror the result steps for both channels.");
    assert(stepAudits.every((event) => event.outcome === "ok"), "successful transfer steps must audit as ok.");

    auditEvents.length = 0;
    workloadTransferService.transferWorkload = async () => {
      throw Object.assign(new Error("restore refused"), {
        code: "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED",
        details: {
          sourceNodeId: nodeA.id,
          targetNodeId: nodeB.id,
          steps: [{ step: "target.restore.confirm", ok: false, errorCode: "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED" }],
        },
      });
    };
    await assert.rejects(
      () => handlers.get("workload:transfer")({}, transferPayload),
      (error) => error?.code === "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED" && Array.isArray(error?.steps),
      "a failed transfer must keep its code and step trail on the IPC error.",
    );
    const failedStepAudits = auditEvents.filter((event) => String(event.action).startsWith("workload.transfer."));
    assert.deepStrictEqual(failedStepAudits.map((event) => event.outcome), ["failed"], "failed transfer steps must audit as failed.");
    progress(6, "IPC: channels gated before the service, per-step audits recorded for ok and failed steps");

    console.log("workload-transfer-smoke passed");
  } finally {
    // --- 7. Cleanup: every spawned process and temp root ---
    await stopAgentProcess(agentA.child);
    await stopAgentProcess(agentB.child);
    if (transferRoot) {
      try { fs.rmSync(transferRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((error) => {
  console.error("workload-transfer-smoke FAILED:", error);
  process.exitCode = 1;
});
