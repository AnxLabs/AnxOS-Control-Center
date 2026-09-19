const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-local-pairing-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
  process.env.ANXOS_LOG_DIR = path.join(root, "logs");
  try {
    const pairing = require("../src/services/localAgentPairingService");
    const control = require("../src/services/agentControlService");
    const client = require("../src/services/agentClient");

    assert.strictEqual(pairing._test.normalizeLocalAgentUrl("http://localhost:47131/"), "http://localhost:47131");
    assert.throws(
      () => pairing._test.normalizeLocalAgentUrl("http://192.168.1.20:47131"),
      /restricted to this computer/i,
      "Automatic pairing must reject non-loopback URLs."
    );

    const first = pairing.pairLocalAgent({ agentUrl: "http://127.0.0.1:47131", reason: "smoke" });
    assert.strictEqual(first.localOnly, true);
    assert.strictEqual(first.credentialStore, "secure-session-store");
    assert.strictEqual(first.restartRequired, false);
    assert(!Object.prototype.hasOwnProperty.call(first, "agentToken"), "Pairing result must not expose the raw token.");

    const status = pairing.readLocalAgentPairingStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.localOnly, true);
    assert.strictEqual(status.fingerprint, first.fingerprint);

    const stored = fs.readFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "local-agent-credentials.json"), "utf8");
    const rawToken = client.readAgentSettings().agentToken;
    assert(rawToken, "Agent config should contain the shared token used by the Agent process.");
    assert(!stored.includes(rawToken), "Encrypted local credential store must not contain the raw token.");

    const rotated = await control.pairLocalAgentSecurely({ rotate: true, reason: "smoke-rotation" });
    assert.strictEqual(rotated.localOnly, true);
    assert.strictEqual(rotated.restartRequired, true);
    assert.notStrictEqual(rotated.fingerprint, first.fingerprint, "Rotation should create a new token fingerprint.");
    assert(!Object.prototype.hasOwnProperty.call(rotated, "agentToken"), "Control pairing result must not expose the raw token.");

    const diagnostics = await control.runDiagnostics();
    assert(diagnostics.checks.some((check) => check.id === "local-pairing" && check.result === "Passed"), "Diagnostics should report local pairing status.");
    console.log("Local Agent pairing smoke checks passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
