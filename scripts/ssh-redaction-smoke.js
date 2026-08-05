const { SshServiceError } = require("../src/services/sshService");
const assert = require("assert").strict;

console.log("=== SshServiceError redaction tests ===");

// Test password=secret123
const error1 = new SshServiceError("Authentication failed", {
  technicalMessage: "password=secret123"
});
assert.equal(error1.message, "Authentication failed", "error.message changed unexpectedly");
assert.ok(Object.prototype.hasOwnProperty.call(error1, "technicalMessage"), "technicalMessage is not an own property");
assert.equal(error1.technicalMessage, "password=[redacted]", "password=secret123 not redacted");

// Test password: "secret123"
const error2 = new SshServiceError("Authentication failed", {
  technicalMessage: "password: \"secret123\""
});
assert.equal(error2.message, "Authentication failed", "error.message changed unexpectedly");
assert.ok(Object.prototype.hasOwnProperty.call(error2, "technicalMessage"), "technicalMessage is not an own property");
assert.equal(error2.technicalMessage, "password=[redacted]", "password: \"secret123\" not redacted");

// Test passphrase=secret123
const error3 = new SshServiceError("Authentication failed", {
  technicalMessage: "passphrase=secret123"
});
assert.equal(error3.message, "Authentication failed", "error.message changed unexpectedly");
assert.ok(Object.prototype.hasOwnProperty.call(error3, "technicalMessage"), "technicalMessage is not an own property");
assert.equal(error3.technicalMessage, "passphrase=[redacted]", "passphrase=secret123 not redacted");

// Test privateKey=-----BEGIN PRIVATE KEY-----abc
const error4 = new SshServiceError("Authentication failed", {
  technicalMessage: "privateKey=-----BEGIN PRIVATE KEY-----abc"
});
assert.equal(error4.message, "Authentication failed", "error.message changed unexpectedly");
assert.ok(Object.prototype.hasOwnProperty.call(error4, "technicalMessage"), "technicalMessage is not an own property");
assert.equal(error4.technicalMessage, "privateKey=[redacted-private-key]", "privateKey=... not redacted");

// Test non-secret message
const error5 = new SshServiceError("Authentication failed", {
  technicalMessage: "Password mismatch: invalid credentials"
});
assert.equal(error5.message, "Authentication failed", "error.message changed unexpectedly");
assert.ok(Object.prototype.hasOwnProperty.call(error5, "technicalMessage"), "technicalMessage is not an own property");
assert.equal(error5.technicalMessage, "Password mismatch: invalid credentials", "Non-secret message redacted");

// Verify JSON serialization
const allErrors = [error1, error2, error3, error4, error5];
const serialized = JSON.stringify(allErrors);
assert.doesNotMatch(serialized, /secret123/, "Secret value appears in JSON serialization");
assert.doesNotMatch(serialized, /-----BEGIN PRIVATE KEY-----/, "Private key payload appears in JSON serialization");

console.log("SSH redaction smoke tests passed.");