const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function assertModuleWorksWithoutElectron(modulePath, statePathRoot) {
  // The Agent runtime never has the "electron" package available, so this
  // framework must degrade gracefully (soft-loaded diagnostics, console
  // fallback) instead of crashing. Force require("electron") to fail the
  // way it would in that runtime and prove the module still functions.
  const script = `
    const Module = require("module");
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, ...rest) {
      if (request === "electron") {
        throw new Error("Cannot find module 'electron' (simulated)");
      }
      return originalLoad.call(this, request, ...rest);
    };
    process.env.ANXHUB_CONFIG_DIR = ${JSON.stringify(statePathRoot)};
    const longOperations = require(${JSON.stringify(modulePath)});
    const operation = longOperations.createOperation({ kind: "agent-safe-smoke", status: "running" });
    longOperations.completeOperation(operation.id);
    const completed = longOperations.getOperation(operation.id);
    if (completed.status !== "complete") {
      throw new Error("Operation did not complete without electron available.");
    }
    console.log("agent-safe-ok");
  `;
  const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert(output.includes("agent-safe-ok"), "Long-operation framework should work when the electron module is unavailable (Agent runtime).");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-long-operation-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");

  const modulePath = require.resolve("../src/shared/longOperationService");
  let longOperations = require(modulePath);

  // Basic lifecycle: create -> update -> complete.
  const created = longOperations.createOperation({
    kind: "smoke-download",
    nodeId: "node-a",
    lockKey: "smoke-download:node-a:template-x",
    stage: "Preparing",
    progressMode: "determinate",
    canCancel: true,
    retryable: true,
    metadata: { fileName: "server.jar" },
  });
  assert(created.id, "createOperation should assign an id.");
  assert.strictEqual(created.status, "queued", "New operations should start queued.");

  longOperations.updateOperation(created.id, { status: "running", progress: 40, stage: "Downloading" });
  const running = longOperations.getOperation(created.id);
  assert.strictEqual(running.status, "running", "Operation status should update.");
  assert.strictEqual(running.progress, 40, "Operation progress should update.");
  assert.strictEqual(running.metadata.fileName, "server.jar", "Metadata should be preserved across updates.");

  longOperations.completeOperation(created.id);
  const completed = longOperations.getOperation(created.id);
  assert.strictEqual(completed.status, "complete", "completeOperation should mark the operation complete.");
  assert.strictEqual(completed.progress, 100, "completeOperation should default progress to 100.");
  assert(completed.completedAt, "completeOperation should stamp completedAt.");

  // Duplicate-prevention / operation locking by lockKey.
  const first = longOperations.createOperation({
    kind: "smoke-lock",
    lockKey: "smoke-lock:shared",
    stage: "Running",
  });
  assert.throws(
    () => longOperations.createOperation({ kind: "smoke-lock", lockKey: "smoke-lock:shared" }),
    (error) => error?.code === "DUPLICATE_OPERATION" && error?.details?.existingOperationId === first.id,
    "Creating an operation with an active lock key should be rejected as a duplicate.",
  );
  longOperations.completeOperation(first.id);
  const afterCompletion = longOperations.createOperation({ kind: "smoke-lock", lockKey: "smoke-lock:shared" });
  assert(afterCompletion.id !== first.id, "A new operation should be allowed once the prior lock holder is terminal.");

  // Cancellation invokes the registered cancel handler.
  const cancellable = longOperations.createOperation({ kind: "smoke-cancel", canCancel: true });
  let cancelInvoked = false;
  longOperations.registerCancelHandler(cancellable.id, () => {
    cancelInvoked = true;
  });
  await longOperations.cancelOperation(cancellable.id);
  assert(cancelInvoked, "cancelOperation should invoke the registered cancel handler.");
  assert.strictEqual(longOperations.getOperation(cancellable.id).status, "cancelled", "Operation should be marked cancelled.");
  await assert.rejects(
    () => longOperations.cancelOperation(cancellable.id),
    /cannot be cancelled/,
    "Cancelling an already-terminal operation should be rejected.",
  );

  const cancellableWithoutHandler = longOperations.createOperation({ kind: "smoke-cancel-missing", canCancel: true });
  await assert.rejects(
    () => longOperations.cancelOperation(cancellableWithoutHandler.id),
    (error) => error?.code === "OPERATION_CANCEL_HANDLER_MISSING",
    "A cancellable operation without a real cancellation handler must fail honestly.",
  );
  assert.notStrictEqual(longOperations.getOperation(cancellableWithoutHandler.id).status, "cancelled", "A missing cancellation handler must not mark the task cancelled.");

  // Retry invokes the registered retry handler.
  const retryable = longOperations.createOperation({ kind: "smoke-retry", canRetry: true });
  let retryInvoked = false;
  longOperations.registerRetryHandler(retryable.id, async () => {
    retryInvoked = true;
    return longOperations.createOperation({ kind: "smoke-retry-attempt", status: "running" });
  });
  const retryResult = await longOperations.retryOperation(retryable.id);
  assert(retryInvoked, "retryOperation should invoke the registered retry handler.");
  assert(retryResult.id && retryResult.id !== retryable.id, "retryOperation should return a genuinely new execution attempt.");

  const notRetryable = longOperations.createOperation({ kind: "smoke-retry", canRetry: false });
  await assert.rejects(
    () => longOperations.retryOperation(notRetryable.id),
    (error) => error?.code === "OPERATION_NOT_RETRYABLE",
    "Retrying a non-retryable operation should be rejected.",
  );

  // canRetry=true must never be a hollow claim: if no retry handler was ever
  // registered, retryOperation should fail loudly with a distinct code rather
  // than silently doing nothing or merely resetting status.
  const retryableWithoutHandler = longOperations.createOperation({ kind: "smoke-retry", canRetry: true });
  await assert.rejects(
    () => longOperations.retryOperation(retryableWithoutHandler.id),
    (error) => error?.code === "OPERATION_RETRY_HANDLER_MISSING",
    "An operation marked canRetry=true with no registered handler should fail with a distinct, honest error code.",
  );

  // rollbackSupported must be explicit and default to false: a capability must
  // never be implied unless a caller actually opts in.
  const noRollback = longOperations.createOperation({ kind: "smoke-rollback-default" });
  assert.strictEqual(noRollback.rollbackSupported, false, "rollbackSupported should default to false unless a caller explicitly claims it.");
  const withRollback = longOperations.createOperation({ kind: "smoke-rollback-explicit", rollbackSupported: true });
  assert.strictEqual(withRollback.rollbackSupported, true, "rollbackSupported should reflect an explicit true claim.");

  // Failure captures a standardized error shape and marks retryable by default.
  const failing = longOperations.createOperation({ kind: "smoke-fail" });
  longOperations.failOperation(failing.id, { code: "NETWORK_ERROR", message: "Connection reset." });
  const failed = longOperations.getOperation(failing.id);
  assert.strictEqual(failed.status, "failed", "failOperation should mark the operation failed.");
  assert.strictEqual(failed.error.code, "NETWORK_ERROR", "failOperation should preserve the error code.");
  assert.strictEqual(failed.canRetry, false, "failOperation must not advertise retry without an executable retry handler.");

  const retryableFailure = longOperations.createOperation({ kind: "smoke-fail-retry" });
  longOperations.registerRetryHandler(retryableFailure.id, async () => ({ retried: true }));
  longOperations.failOperation(retryableFailure.id, { code: "NETWORK_ERROR", message: "Connection reset." }, { retryable: true });
  assert.strictEqual(longOperations.getOperation(retryableFailure.id).canRetry, true, "A failed operation with a registered retry handler may advertise retry.");

  // Timeout handling: an operation with a short timeout should auto-fail.
  const timingOut = longOperations.createOperation({ kind: "smoke-timeout", status: "running", timeoutMs: 30, canCancel: true });
  let timedOutTaskCancelled = false;
  longOperations.registerCancelHandler(timingOut.id, () => { timedOutTaskCancelled = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const timedOut = longOperations.getOperation(timingOut.id);
  assert.strictEqual(timedOut.status, "failed", "An operation exceeding its timeout should be auto-failed.");
  assert.strictEqual(timedOut.error.code, "OPERATION_TIMEOUT", "Timeout failures should use a standardized error code.");
  assert.strictEqual(timedOutTaskCancelled, true, "Timeout must cancel the real underlying task before releasing its lock.");

  const nonCancellableTimeout = longOperations.createOperation({ kind: "smoke-timeout-locked", lockKey: "timeout:locked", status: "running", timeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(longOperations.getOperation(nonCancellableTimeout.id).status, "running", "A timeout must not fake terminal failure when underlying cancellation is unsupported.");
  assert.strictEqual(longOperations.getOperation(nonCancellableTimeout.id).stage, "timeout-exceeded", "Unsupported timeout cancellation should be explicit.");
  assert.throws(() => longOperations.createOperation({ kind: "smoke-timeout-locked", lockKey: "timeout:locked" }), (error) => error?.code === "DUPLICATE_OPERATION", "A live non-cancellable task must keep its lock after exceeding the expected duration.");

  // listOperations supports filtering by kind/nodeId/status.
  longOperations.createOperation({ kind: "smoke-filter", nodeId: "node-b", status: "running" });
  const filtered = longOperations.listOperations({ kind: "smoke-filter", nodeId: "node-b" });
  assert.strictEqual(filtered.length, 1, "listOperations should filter by kind and nodeId.");

  // Persistence + crash recovery: force a flush, reload the module fresh, and confirm
  // active operations are marked interrupted rather than silently resumed or lost.
  const persistent = longOperations.createOperation({
    kind: "smoke-persist",
    status: "running",
    retryable: true,
    metadata: { note: "in-flight at simulated crash" },
  });
  longOperations._test.flushPersist();
  const statePath = longOperations.getOperationsStatePath();
  assert(fs.existsSync(statePath), "Long-operation state should be persisted to disk.");
  const persistedRaw = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(persistedRaw.operations.some((entry) => entry.id === persistent.id), "Persisted snapshot should include the in-flight operation.");

  delete require.cache[modulePath];
  longOperations = require(modulePath);
  const recovered = longOperations.getOperation(persistent.id);
  assert(recovered, "Recovered operation should exist after simulated restart.");
  assert.strictEqual(recovered.status, "interrupted", "An operation active at restart should be marked interrupted, not left running.");
  assert.strictEqual(recovered.error.code, "INTERRUPTED_BY_RESTART", "Interrupted operations should carry a standardized error code.");
  assert.strictEqual(recovered.canCancel, false, "Interrupted operations should not claim to be cancellable.");
  assert.strictEqual(recovered.canRetry, false, "A recovered operation must not advertise retry because runtime retry handlers do not survive restart.");
  assert.strictEqual(recovered.metadata.note, "in-flight at simulated crash", "Recovered metadata should be preserved.");

  // Unsupported future schemas must fail without overwriting or mutating the
  // recovery file. Silently starting empty here would lose operation history.
  const futureState = {
    schemaVersion: longOperations.OPERATION_SCHEMA_VERSION + 1,
    operations: [{ id: "future-operation", status: "running" }],
  };
  fs.writeFileSync(statePath, `${JSON.stringify(futureState, null, 2)}\n`, { mode: 0o600 });
  delete require.cache[modulePath];
  longOperations = require(modulePath);
  assert.throws(
    () => longOperations.listOperations(),
    (error) => error?.code === "OPERATION_SCHEMA_UNSUPPORTED"
      && error?.details?.schemaVersion === futureState.schemaVersion,
    "A future long-operation schema should fail safely with a stable error code.",
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), futureState, "A rejected future schema must remain unchanged.");

  // Corrupt state must also fail explicitly and retain a diagnostic copy.
  fs.writeFileSync(statePath, "{not-json\n", { mode: 0o600 });
  delete require.cache[modulePath];
  longOperations = require(modulePath);
  assert.throws(
    () => longOperations.listOperations(),
    (error) => error?.code === "OPERATION_STATE_CORRUPT",
    "Corrupt long-operation state should fail explicitly instead of silently discarding records.",
  );
  const corruptBackups = fs.readdirSync(path.dirname(statePath)).filter((name) => name.startsWith(`${path.basename(statePath)}.corrupt-`));
  assert(corruptBackups.length > 0, "Corrupt long-operation state should be preserved in a diagnostic backup.");

  fs.rmSync(statePath, { force: true });
  delete require.cache[modulePath];
  longOperations = require(modulePath);

  // Persisted snapshots must never contain non-serializable runtime handles.
  const withController = longOperations.createOperation({
    kind: "smoke-controller",
    status: "running",
    metadata: { controller: new AbortController() },
  });
  longOperations._test.flushPersist();
  const persistedAfterController = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const controllerEntry = persistedAfterController.operations.find((entry) => entry.id === withController.id);
  assert(controllerEntry, "Operation with a controller should still be persisted.");
  assert.strictEqual(controllerEntry.metadata.controller, undefined, "Non-serializable controller objects must be stripped before persistence.");
  assert.strictEqual(longOperations.getOperation(withController.id).metadata.controller instanceof AbortController, true, "The live in-memory metadata reference must retain the controller for runtime cancellation.");

  // Persisted snapshots must never leak secrets that end up in operation
  // metadata, whether via a sensitive key name or a bearer-token-shaped value
  // embedded in an otherwise plain string (e.g. a signed download URL).
  const withSecrets = longOperations.createOperation({
    kind: "smoke-secrets",
    status: "running",
    metadata: {
      agentToken: "anxos_super-secret-token-value",
      note: "safe",
      downloadUrl: "https://example.test/file.zip?token=abc123&Authorization=Bearer sk_live_abcdefghijklmnop",
    },
  });
  longOperations._test.flushPersist();
  const persistedAfterSecrets = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const secretsEntry = persistedAfterSecrets.operations.find((entry) => entry.id === withSecrets.id);
  assert(secretsEntry, "Operation with secret-shaped metadata should still be persisted.");
  assert.strictEqual(secretsEntry.metadata.agentToken, "[redacted]", "A sensitive key name must be fully redacted before persistence.");
  assert.strictEqual(secretsEntry.metadata.note, "safe", "Non-sensitive metadata must be preserved as-is.");
  assert(!secretsEntry.metadata.downloadUrl.includes("sk_live_abcdefghijklmnop"), "A bearer-token-shaped value embedded in a string must be redacted before persistence.");
  assert.strictEqual(longOperations.getOperation(withSecrets.id).metadata.agentToken, "anxos_super-secret-token-value", "The live in-memory metadata must retain real values for runtime use; only the persisted copy is redacted.");

  // The Agent runtime requires this module without "electron" installed.
  assertModuleWorksWithoutElectron(modulePath, fs.mkdtempSync(path.join(os.tmpdir(), "anxos-long-operation-agent-safe-")));

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("Long-operation framework smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
