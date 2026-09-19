const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-persistent-session-"));
process.env.ANXHUB_CONFIG_DIR = root;
const security = require("../src/services/securityService");
const filePath = path.join(root, "session.dat");
const payload = { sessionId: "session-a", token: "secret-token", expiresAt: new Date(Date.now() + 60000).toISOString() };

const legacy = security._test.encryptLocalSession(payload);
delete legacy.schemaVersion;
fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
assert.deepStrictEqual(security._test.readPersistentSessionFile(), payload, "Legacy remembered sessions should remain readable.");
assert.strictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, 1, "Legacy remembered sessions should migrate to the current schema.");
assert(fs.existsSync(`${filePath}.schema-v0.backup`), "Legacy encrypted session state should be preserved before migration.");
assert(!fs.readFileSync(`${filePath}.schema-v0.backup`, "utf8").includes("secret-token"), "Remembered-session migration backups must stay encrypted.");

const future = { schemaVersion: 2, method: "future", data: "opaque" };
fs.writeFileSync(filePath, JSON.stringify(future), { mode: 0o600 });
assert.strictEqual(security._test.readPersistentSessionFile(), null, "Future remembered sessions should fail safely as signed out.");
assert.throws(() => security._test.writePersistentSessionFile(payload), (error) => error?.code === "PERSISTENT_SESSION_SCHEMA_UNSUPPORTED", "Future remembered-session state must not be overwritten.");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), future);

fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
assert.strictEqual(security._test.readPersistentSessionFile(), null, "Corrupt remembered sessions should fail safely as signed out.");
assert.throws(() => security._test.writePersistentSessionFile(payload), (error) => error?.code === "PERSISTENT_SESSION_CORRUPT", "Corrupt remembered-session state must require explicit reset before replacement.");
assert(fs.readdirSync(root).some((name) => name.startsWith("session.dat.corrupt-") && name.endsWith(".backup")), "Corrupt remembered-session state should be preserved.");
assert.strictEqual(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false, "Remembered-session writes should not leave temporary files.");

fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log("Persistent session store smoke checks passed.");
