#!/usr/bin/env node
const assert = require("assert");
const recovery = require("../src/services/authRecoveryState");

recovery.enterRestorePending();
assert.strictEqual(recovery.getState().state, "restore_pending");

recovery.enterLockedRecoverable({ code: "SECURE_SESSION_DECRYPT_FAILED" }, { source: "test" });
assert.strictEqual(recovery.getState().state, "locked_recoverable");
assert.strictEqual(recovery.getState().lockedRecoverable, true);
assert.throws(
  () => recovery.requireUnlocked("agent-control:start", "Unlock AnxOS to start the Local Agent."),
  (error) => error?.code === "AUTH_UNLOCK_REQUIRED" && !error.message.includes("SECURE_SESSION_DECRYPT_FAILED"),
);

recovery.enterUnlocking();
assert.strictEqual(recovery.getState().state, "unlocking");
assert.throws(() => recovery.requireLocalCredentialsUnlocked("security:rotate-token"), (error) => error?.code === "LOCAL_AUTHENTICATION_REQUIRED");

recovery.enterUnlocked({ provider: "local-owner" });
assert.strictEqual(recovery.getState().state, "unlocked");
assert.doesNotThrow(() => recovery.requireUnlocked("nodes:save"));

console.log("Auth recovery state smoke checks passed.");
