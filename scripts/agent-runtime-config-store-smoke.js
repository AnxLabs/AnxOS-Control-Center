const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AGENT_RUNTIME_CONFIG_SCHEMA_VERSION,
  readAgentRuntimeConfig,
  restoreAgentRuntimeConfig,
  saveAgentRuntimeConfig,
} = require("../src/shared/agentRuntimeConfigStore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-runtime-config-"));
const filePath = path.join(root, "agent-runtime.json");

assert.deepStrictEqual(readAgentRuntimeConfig(filePath, { defaults: { port: 47131 } }), { port: 47131 }, "Missing configuration should use explicit defaults.");

fs.writeFileSync(filePath, '{"port":48123}\n');
const legacyMtime = new Date(Date.now() - 10000);
fs.utimesSync(filePath, legacyMtime, legacyMtime);
const migrated = readAgentRuntimeConfig(filePath);
assert.strictEqual(migrated.port, 48123);
assert.strictEqual(migrated.schemaVersion, AGENT_RUNTIME_CONFIG_SCHEMA_VERSION);
assert(fs.existsSync(`${filePath}.pre-migration-v0.backup`), "Legacy configuration should be backed up before migration.");
assert.strictEqual(Math.round(fs.statSync(filePath).mtimeMs / 1000), Math.round(legacyMtime.getTime() / 1000), "Schema migration should preserve modification time used by restart detection.");

saveAgentRuntimeConfig(filePath, { port: 49123 });
assert.strictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, AGENT_RUNTIME_CONFIG_SCHEMA_VERSION);
assert.strictEqual(JSON.parse(fs.readFileSync(`${filePath}.backup`, "utf8")).port, 48123, "Save should retain the previous valid configuration.");

const restored = restoreAgentRuntimeConfig(filePath);
assert.strictEqual(restored.port, 48123, "Restore should create a new atomic execution from the backup.");
assert.strictEqual(JSON.parse(fs.readFileSync(`${filePath}.backup`, "utf8")).port, 48123, "Restore should retain the known-good backup.");
assert(fs.readdirSync(root).some((name) => name.startsWith("agent-runtime.json.pre-restore-")), "Restore should preserve the replaced state separately.");

fs.writeFileSync(filePath, "{broken");
assert.throws(() => readAgentRuntimeConfig(filePath), (error) => error?.code === "AGENT_RUNTIME_CONFIG_CORRUPT" && error?.configPath === filePath);

fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION + 1, port: 50123 }));
assert.throws(() => readAgentRuntimeConfig(filePath), (error) => error?.code === "AGENT_RUNTIME_CONFIG_FUTURE_VERSION");

assert.strictEqual(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false, "Atomic writes should not leave temporary files.");
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log("Agent runtime configuration store smoke checks passed.");
