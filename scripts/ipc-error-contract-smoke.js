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
assert.strictEqual(wrapped.cause, source, "The original cause should remain available inside the trusted main process.");
assert(!Object.keys(wrapped).includes("cause"), "The raw cause must not be serialized to the renderer.");
assert(!wrapped.message.includes(secret), "Renderer-visible IPC messages must redact secrets.");
assert(wrapped.message.includes("Restore failed"), "IPC friendly error behavior must remain intact after diagnostic path redaction.");

console.log("IPC error contract smoke checks passed.");
