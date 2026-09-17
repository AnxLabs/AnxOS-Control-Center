const assert = require("assert");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-diagnostics-redaction-");

const { serializeError } = require("../src/services/marketplaceInstallService")._test;

const secret = "marketplace-secret-token";
const error = Object.assign(new Error(`Authorization: Bearer ${secret}`), {
  code: "PROVIDER_REQUEST_FAILED",
  details: {
    authorization: `Bearer ${secret}`,
    headers: { Authorization: `Bearer ${secret}` },
    body: `api_key=${secret}`,
    responseBody: `token=${secret}`,
    payload: { password: secret },
    stack: `Error: api_key=${secret}`,
    originalStack: `Error: token=${secret}`,
    url: "https://provider.example.test/file",
    causeCode: "ECONNRESET",
  },
});

const serialized = serializeError(error, { operation: "install", agentToken: secret });
const output = JSON.stringify(serialized);

assert(!output.includes(secret), "Marketplace diagnostics must redact credentials and secret-shaped values.");
for (const forbidden of ["stack", "originalStack", "body", "responseBody", "payload", "headers", "authorization"]) {
  assert(!Object.prototype.hasOwnProperty.call(serialized, forbidden), `Marketplace diagnostics must omit top-level ${forbidden}.`);
  assert(!Object.prototype.hasOwnProperty.call(serialized.details || {}, forbidden), `Marketplace diagnostics must omit detail ${forbidden}.`);
}
assert.strictEqual(serialized.code, "PROVIDER_REQUEST_FAILED");
assert.strictEqual(serialized.details.causeCode, "ECONNRESET");
assert.strictEqual(serialized.url, "https://provider.example.test/file");

console.log("Marketplace diagnostic redaction smoke checks passed.");
