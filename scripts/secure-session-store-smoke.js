const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SECURE_SESSION_SCHEMA_VERSION, SecureSessionStore, encryptPayload } = require("../src/services/secureSessionStore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-secure-session-"));
const store = new SecureSessionStore({ configDirectory: root, fileName: "account.json" });
const session = { accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: Date.now() + 60000 };

store.write(session);
const serialized = fs.readFileSync(store.filePath, "utf8");
assert.strictEqual(JSON.parse(serialized).schemaVersion, SECURE_SESSION_SCHEMA_VERSION);
assert(!serialized.includes("secret-access") && !serialized.includes("secret-refresh"), "Encrypted session files must not contain plaintext tokens.");
assert.deepStrictEqual(store.read(), session);

fs.writeFileSync(store.filePath, `${JSON.stringify(encryptPayload(session, store.filePath))}\n`, { mode: 0o600 });
assert.deepStrictEqual(store.read(), session, "Legacy encrypted sessions should remain readable.");
assert(fs.existsSync(`${store.filePath}.schema-v0.backup`), "Legacy encrypted sessions should be preserved before migration.");
assert(!fs.readFileSync(`${store.filePath}.schema-v0.backup`, "utf8").includes("secret-access"), "Migration backups must remain encrypted.");

fs.writeFileSync(store.filePath, JSON.stringify({ schemaVersion: SECURE_SESSION_SCHEMA_VERSION + 1, method: "future" }));
const futureRaw = fs.readFileSync(store.filePath, "utf8");
assert.throws(() => store.read(), (error) => error?.code === "SECURE_SESSION_SCHEMA_UNSUPPORTED");
assert.throws(() => store.write(session), (error) => error?.code === "SECURE_SESSION_SCHEMA_UNSUPPORTED");
assert.strictEqual(fs.readFileSync(store.filePath, "utf8"), futureRaw, "Future encrypted session state must not be overwritten.");

fs.writeFileSync(store.filePath, "{broken");
const corruptRaw = fs.readFileSync(store.filePath, "utf8");
assert.throws(() => store.read(), (error) => error?.code === "SECURE_SESSION_CORRUPT");
assert.throws(() => store.write(session), (error) => error?.code === "SECURE_SESSION_CORRUPT");
assert.strictEqual(fs.readFileSync(store.filePath, "utf8"), corruptRaw, "Corrupt encrypted session state must not be overwritten.");
assert(fs.readdirSync(root).some((name) => name.includes(".corrupt-") && name.endsWith(".backup")), "Corrupt encrypted state should be preserved for recovery.");
store.replacePreservingUnreadable(session);
assert.deepStrictEqual(store.read(), session, "Explicit recovery replacement should write a fresh readable secure session.");
assert(fs.readdirSync(root).some((name) => name.includes(".recovery-") && name.endsWith(".backup")), "Recovery replacement must preserve the unreadable encrypted state.");
assert.strictEqual(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false, "Atomic session writes should clean temporary files.");

fs.rmSync(root, { recursive: true, force: true });
console.log("Secure session store smoke checks passed.");
