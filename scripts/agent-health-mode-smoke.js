const assert = require("assert");
const { _test } = require("../agent/src/routes/health");

function setOf(...tokens) {
  return new Set(tokens);
}

async function main() {
  // Default API permission set is "*", so write is enabled. The agent must not
  // claim read-only when mutations are permitted.
  assert.strictEqual(_test.computeHealthMode(setOf("*")), "read-write", "Default '*' permissions are read-write, not read-only.");
  assert.strictEqual(_test.computeHealthMode(setOf("*:*")), "read-write");

  // Explicitly non-mutating tokens are honestly read-only.
  assert.strictEqual(_test.computeHealthMode(setOf("instance:read")), "read-only");
  assert.strictEqual(_test.computeHealthMode(setOf("instance:read", "docker:read", "system:read", "files:read")), "read-only");

  // Any write-capable or wildcard write token flips the agent to read-write.
  assert.strictEqual(_test.computeHealthMode(setOf("instance:write")), "read-write");
  assert.strictEqual(_test.computeHealthMode(setOf("docker:write")), "read-write");
  assert.strictEqual(_test.computeHealthMode(setOf("instance:read", "backups:restore")), "read-write");
  assert.strictEqual(_test.computeHealthMode(setOf("docker:*")), "read-write", "A category write wildcard enables writes.");

  // An empty permission set authorizes nothing.
  assert.strictEqual(_test.computeHealthMode(setOf()), "no-access");

  assert.strictEqual(_test.isWriteEnabled(setOf("*")), true);
  assert.strictEqual(_test.isWriteEnabled(setOf("instance:read")), false);

  console.log(JSON.stringify({
    status: "PASS",
    classification: "HEALTH MODE DERIVED FROM PERMISSIONS",
    defaultMode: _test.computeHealthMode(setOf("*")),
    readOnlyMode: _test.computeHealthMode(setOf("instance:read")),
    noAccessMode: _test.computeHealthMode(setOf()),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});