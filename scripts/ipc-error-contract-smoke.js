const assert = require("assert");
const { createIpcError, normalizeIpcError } = require("../src/shared/ipcError");

const secret = "secret-agent-token-value";
const source = Object.assign(new Error(`Restore failed Authorization: Bearer ${secret}`), {
  code: "BACKUP_RESTORE_FAILED",
  status: 409,
  details: {
    suggestion: "Stop the instance and retry.",
    retryable: true,
    provider: "local-agent",
    nodeId: "node-a",
    diagnostics: {
      token: secret,
      stage: "extract",
      backupRoot: "/opt/AnxOS Control Center/Backups/Nested Folder",
    },
  },
});
const contract = normalizeIpcError(source);
assert.strictEqual(contract.code, "BACKUP_RESTORE_FAILED");
assert.strictEqual(contract.retryable, true);
assert.strictEqual(contract.status.code, 409);
assert.strictEqual(contract.provider.id, "local-agent");
assert.strictEqual(contract.suggestion, "Stop the instance and retry.");
assert(!JSON.stringify(contract).includes(secret), "IPC error contracts must redact secrets.");
assert.strictEqual(contract.diagnostics.token, "[redacted]");
assert.strictEqual(contract.diagnostics.backupRoot, "[redacted-path]", "IPC technical diagnostics must fully redact allowlisted path fields.");

const wrapped = createIpcError(source);
assert(wrapped.message.startsWith("BACKUP_RESTORE_FAILED:"), "Thrown IPC errors must retain their stable code in the renderer-visible message.");
assert.strictEqual(wrapped.details.code, "BACKUP_RESTORE_FAILED");
// The cause is a sanitized projection, not the raw error: anything that logs or
// serializes it (including a nested cause/response chain) must never see the
// secret, while the stable metadata stays available to main-process callers.
assert.notStrictEqual(wrapped.cause, source, "The cause must be a sanitized projection, not the raw error.");
assert.strictEqual(wrapped.cause.code, "BACKUP_RESTORE_FAILED", "The projected cause keeps the stable error code.");
assert.strictEqual(wrapped.cause.status, 409, "The projected cause keeps the status.");
assert(wrapped.cause.message.startsWith("Restore failed"), "The projected cause keeps the (redacted) message.");
assert(!JSON.stringify(wrapped.cause).includes(secret), "The projected cause must redact secrets.");
assert(!Object.keys(wrapped).includes("cause"), "The cause must not be serialized to the renderer.");

const nestedSecret = "nested-provider-token-value";
const nested = createIpcError(Object.assign(new Error("Provider request failed."), {
  code: "PROVIDER_REQUEST_FAILED",
  response: { status: 401, statusText: "Unauthorized", data: { error: `Authorization: Bearer ${nestedSecret}` } },
  cause: Object.assign(new Error(`Upstream rejected Authorization: Bearer ${nestedSecret}`), { code: "ERR_BAD_RESPONSE" }),
}));
assert.strictEqual(nested.statusCode, 401, "The status code falls back to the nested response status.");
assert.strictEqual(nested.cause.cause.code, "ERR_BAD_RESPONSE", "Nested cause codes survive the projection.");
assert(!JSON.stringify(nested.cause).includes(nestedSecret), "Secrets nested in a cause chain or response are redacted.");
assert(!JSON.stringify(nested.details).includes(nestedSecret), "Renderer-visible details never carry a nested secret.");
assert(!wrapped.message.includes(secret), "Renderer-visible IPC messages must redact secrets.");
assert(wrapped.message.includes("Restore failed"), "IPC friendly error behavior must remain intact after diagnostic path redaction.");

console.log("IPC error contract smoke checks passed.");
