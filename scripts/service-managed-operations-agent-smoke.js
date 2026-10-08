"use strict";

// The operations API against the REAL Agent HTTP server (systemd is the only fake): overview,
// preflight, the guarded Safe Restart, the restart lock, the audit trail, and the boundaries.

const assert = require("assert");
const { startServiceManagedAgent, INSTANCE_ID } = require("./test-helpers/service-managed-agent-fixture");

const base = `/api/v1/instances/${INSTANCE_ID}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOperation(agent, id, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const response = await agent.api("GET", `${base}/service/operations/${id}`);
    assert.strictEqual(response.status, 200, response.text);
    if (response.json.operation.phase === "finished") return response.json.operation;
    assert.ok(Date.now() - started < timeoutMs, `operation did not finish: ${JSON.stringify(response.json.operation.steps)}`);
    await delay(200);
  }
}


async function permissionTiers() {
  // Reads are instance:read; Safe Restart is instance:lifecycle. A read-only principal cannot restart.
  const readOnly = await startServiceManagedAgent({ operations: true, permissions: "instance:read" });
  try {
    let response = await readOnly.api("GET", `${base}/service/overview`);
    assert.strictEqual(response.status, 200, response.text);
    response = await readOnly.api("GET", `${base}/service/safe-restart/preflight`);
    assert.strictEqual(response.status, 200, response.text);
    response = await readOnly.api("GET", `${base}/service/history`);
    assert.strictEqual(response.status, 200);
    response = await readOnly.api("POST", `${base}/service/safe-restart`, { confirm: true });
    assert.strictEqual(response.status, 403, "a read-only principal must not start a Safe Restart");
    assert.strictEqual(readOnly.restartCalls().length, 0);
  } finally {
    await readOnly.stop();
  }
  const lifecycle = await startServiceManagedAgent({ operations: true, permissions: "instance:read,instance:lifecycle" });
  try {
    const response = await lifecycle.api("POST", `${base}/service/safe-restart`, { confirm: true });
    assert.strictEqual(response.status, 202, response.text);
    await waitForOperation(lifecycle, response.json.operation.id);
    assert.strictEqual(lifecycle.restartCalls().length, 1);
  } finally {
    await lifecycle.stop();
  }
}

async function main() {
  const agent = await startServiceManagedAgent({
    operations: true,
    deployment: {
      schema: 1,
      agentBuild: { origin: "local-unofficial", artifactVersion: "2.0-build206", builtFromCommit: "cc862de", note: "temporary" },
      rollback: { artifact: { name: "AnxOS-Agent-2.0-build205.deb", path: "/nonexistent/rollback.deb", sha256: "a".repeat(64) }, backup: { dir: "/nonexistent/backup", createdAt: "2026-10-07T22:20:31Z" } },
      notes: ["kept for rollback"],
    },
  });
  try {
    // ---- read-only evidence ----
    let response = await agent.api("GET", `${base}/service/overview`);
    assert.strictEqual(response.status, 200, response.text);
    const overview = response.json.service;
    assert.strictEqual(overview.unit, agent.unit);
    assert.strictEqual(overview.systemd.mainPid, 4242);
    assert.ok(overview.systemd.uptimeSeconds >= 3500, "uptime is computed from the unit start time");
    assert.deepStrictEqual([overview.anxrp.ready, overview.anxrp.bootId], [true, "boot-1"]);
    assert.strictEqual(overview.players.count, 0);
    assert.strictEqual(overview.listeners.allListening, true);
    assert.strictEqual(overview.safeRestart.available, true);
    assert.deepStrictEqual([overview.deployment.declared, overview.deployment.unofficial], [true, true], "the unofficial agent build is surfaced");
    assert.strictEqual(overview.deployment.rollback.artifact.state, "missing", "a rollback artifact that is gone is reported as missing");
    assert.ok(!JSON.stringify(overview).includes("Player 0"), "no player names");
    assert.strictEqual(agent.restartCalls().length, 0, "reads never control the service");

    response = await agent.api("GET", `${base}/service/safe-restart/preflight`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.json.preflight.ok, true, JSON.stringify(response.json.preflight.checks));

    // ---- refusals: no players, no confirmation, wrong identity; none restarts anything ----
    response = await agent.api("POST", `${base}/service/safe-restart`, {});
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.json.error.code, "SERVICE_SAFE_RESTART_CONFIRMATION_REQUIRED");

    agent.setPlayers(2);
    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.json.error.code, "SERVICE_SAFE_RESTART_REFUSED");
    const failed = response.json.error.details.checks.find((check) => check.status === "fail");
    assert.strictEqual(failed.id, "players", JSON.stringify(response.json.error.details.checks));
    assert.ok(!JSON.stringify(response.json).includes("license:"), "no identifiers in the refusal");
    agent.setPlayers(0);

    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true, expectedMainPid: 1 });
    assert.strictEqual(response.status, 409, "a stale view (wrong MainPID) is refused");
    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true, expectedUnit: "ssh.service" });
    assert.strictEqual(response.status, 409, "a different unit is refused");
    agent.setFxDown(true);
    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true });
    assert.strictEqual(response.status, 409, "an unverifiable player count is refused");
    agent.setFxDown(false);
    assert.strictEqual(agent.restartCalls().length, 0, "no refusal restarted anything");

    // ---- the guarded restart ----
    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true, expectedMainPid: 4242, expectedUnit: agent.unit });
    assert.strictEqual(response.status, 202, response.text);
    const operation = response.json.operation;
    assert.strictEqual(operation.phase, "started");

    // While it runs, nothing else may drive the service, and a second Safe Restart is refused.
    response = await agent.api("POST", `${base}/restart`);
    assert.strictEqual(response.status, 409, "plain restart is locked during a Safe Restart");
    assert.strictEqual(response.json.error.code, "SERVICE_OPERATION_IN_PROGRESS");
    response = await agent.api("POST", `${base}/stop`);
    assert.strictEqual(response.status, 409);
    response = await agent.api("POST", `${base}/service/safe-restart`, { confirm: true });
    assert.strictEqual(response.status, 409, "a second Safe Restart is refused");

    const finished = await waitForOperation(agent, operation.id);
    assert.strictEqual(finished.outcome, "succeeded", JSON.stringify(finished.steps));
    assert.deepStrictEqual(finished.steps.map((step) => step.id), ["preflight", "players-recheck", "restart", "new-process", "listeners", "ready", "stable"]);
    assert.ok(finished.steps.every((step) => step.status === "pass"));
    assert.strictEqual(finished.pre.mainPid, 4242);
    assert.notStrictEqual(finished.post.mainPid, 4242);
    assert.deepStrictEqual([finished.pre.bootId, finished.post.bootId], ["boot-1", "boot-2"]);
    assert.strictEqual(agent.restartCalls().length, 1, "exactly one systemctl restart in total");
    assert.deepStrictEqual(agent.spawnAttempts().filter((entry) => /fxserver|FXServer|run\.sh/i.test(entry.command)), [], "the Agent never launched the workload");

    // ---- audit trail ----
    response = await agent.api("GET", `${base}/service/history`);
    assert.strictEqual(response.status, 200);
    const history = response.json.history;
    assert.strictEqual(history[0].id, operation.id);
    assert.strictEqual(history[0].outcome, "succeeded");
    assert.ok(history.some((entry) => entry.outcome === "refused"), "refusals are in the history too");
    const lines = agent.historyLines();
    assert.ok(lines.filter((line) => line.id === operation.id).map((line) => line.phase).join() === "started,finished");
    assert.ok(!JSON.stringify(lines).includes("Player 0") && !JSON.stringify(lines).includes("license:"), "no player data in the audit file");

    // ---- the lock is released: ordinary lifecycle works again and is itself audited ----
    response = await agent.api("POST", `${base}/restart`);
    assert.strictEqual(response.status, 200, response.text);
    response = await agent.api("GET", `${base}/service/history`);
    assert.ok(response.json.history.some((entry) => entry.kind === "restart" && entry.outcome === "succeeded"), "plain restarts are audited");

    // ---- boundaries ----
    response = await agent.api("GET", `${base}/service/operations/${"x".repeat(100)}`);
    assert.strictEqual(response.status, 404);
    response = await agent.api("GET", `${base}/service/operations/..%2F..%2Fetc%2Fpasswd`);
    assert.strictEqual(response.status, 404);
    for (const [method, pathname] of [["POST", `${base}/kill`], ["DELETE", base], ["POST", `${base}/duplicate`], ["POST", `${base}/console`]]) {
      const refused = await agent.api(method, pathname, {});
      assert.ok(refused.status >= 400, `${method} ${pathname} must stay refused (got ${refused.status})`);
    }
    response = await agent.api("GET", "/api/v1/instances/does-not-exist/service/overview");
    assert.ok(response.status >= 400, "unknown instance");
    await permissionTiers();
    console.log("service-managed-operations-agent-smoke passed");
  } finally {
    await agent.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
