#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "localAgentPairingService.js"),
  "utf8",
);

assert(source.includes('error?.code !== "SECURE_SESSION_DECRYPT_FAILED"'));
assert(source.includes("readAgentSettings()"));
assert(source.includes('reason: "legacy-config-recovery"'));
assert(source.includes("store.replacePreservingUnreadable(recovered)"));
assert(source.includes("credentialRecovery"));

console.log("Local Agent credential recovery smoke checks passed.");
