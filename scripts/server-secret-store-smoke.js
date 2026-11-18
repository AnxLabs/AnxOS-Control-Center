#!/usr/bin/env node
"use strict";

// Server secret store (docs/SERVER_SECRET_STORE.md), against the real store
// and the real instance engine with a real child process. Temp folders only.
//   K1 values are encrypted (no plaintext on disk), the key is a separate
//      file, and a value only decrypts for its own server and setting
//   K2 a tampered store refuses the value
//   K3 a create keeps names only in config.json and the public view; the
//      rule against secret-named ordinary settings is unchanged
//   K4 the server process receives the value; the "Launch command" line
//      shows only the name; the value printed by the server is scrubbed from
//      its log and crash tail; an installer run does not receive it
//   K5 a server whose value is missing (a move, a lost key) refuses to start
//   K6 an update replaces the value; a key rotation re-encrypts and the old
//      key no longer opens the store; an external key file is used as is
//   K7 deleting the server deletes its values
//   K8 the desktop sends generated passwords only through the write-only
//      field, shows them once, and removes a server an older Agent created
//      without the secret; a template cannot put a value in its command
// Run: node scripts/server-secret-store-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-secret-store-"));
const instanceRoot = path.join(root, "instances");
fs.mkdirSync(instanceRoot, { recursive: true });
Object.assign(process.env, {
  AGENT_INSTANCE_ROOT: instanceRoot,
  ANXOS_LOG_DIR: path.join(root, "logs"),
  AGENT_INSTANCE_EXECUTABLE_ROOTS: path.dirname(process.execPath),
  ANXHUB_CONFIG_DIR: path.join(root, "config"),
});
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
const quiet = () => {};
console.info = quiet; console.warn = quiet; console.debug = quiet;

const repo = path.resolve(__dirname, "..");
const store = require(path.join(repo, "src/shared/instances/instanceSecretStore"));
const core = require(path.join(repo, "src/shared/instances/instanceServiceCore"));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await delay(200);
  }
}
function filesUnder(folder) {
  const found = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else found.push(full); } };
  if (fs.existsSync(folder)) walk(folder);
  return found;
}
const containing = (value) => filesUnder(root).filter((file) => fs.readFileSync(file).includes(value)).map((file) => path.relative(root, file));
const secretsFile = path.join(store.storeRoot(instanceRoot), "secrets.json");
const keyFile = path.join(store.storeRoot(instanceRoot), "server-secrets.key");

async function main() {
  // K1
  const value = `Aa${crypto.randomBytes(12).toString("hex")}`;
  store.setServerSecrets(instanceRoot, "server-a", { ANXOS_TEST_PASSWORD: value });
  assert.deepStrictEqual(store.readServerSecretsForStart(instanceRoot, "server-a", ["ANXOS_TEST_PASSWORD"]), { ANXOS_TEST_PASSWORD: value });
  assert.deepStrictEqual(containing(value), [], "no file holds the value in plain text");
  assert.ok(fs.existsSync(keyFile) && fs.readFileSync(keyFile).length === 32, "the key is a separate 32-byte file");
  assert.ok(!fs.readFileSync(secretsFile, "utf8").includes(fs.readFileSync(keyFile).toString("base64")), "the store does not contain the key");
  assert.strictEqual(path.dirname(secretsFile), path.join(root, "anxos-server-secrets"), "the store is outside every server folder");
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(secretsFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  }
  const raw = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  raw.entries["server-b"] = { ANXOS_TEST_PASSWORD: raw.entries["server-a"].ANXOS_TEST_PASSWORD, ANXOS_OTHER: raw.entries["server-a"].ANXOS_TEST_PASSWORD };
  fs.writeFileSync(secretsFile, JSON.stringify(raw));
  assert.throws(() => store.readServerSecretsForStart(instanceRoot, "server-b", ["ANXOS_TEST_PASSWORD"]), (error) => error.code === "SERVER_SECRET_UNAVAILABLE", "a value copied to another server does not decrypt");
  console.log("PASS K1 values are encrypted, the key is separate, and a value only opens for its own server");

  // K2
  const tampered = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  const record = tampered.entries["server-a"].ANXOS_TEST_PASSWORD;
  const bytes = Buffer.from(record.data, "base64"); bytes[0] ^= 1; record.data = bytes.toString("base64");
  fs.writeFileSync(secretsFile, JSON.stringify(tampered));
  assert.throws(() => store.readServerSecretsForStart(instanceRoot, "server-a", ["ANXOS_TEST_PASSWORD"]), (error) => error.code === "SERVER_SECRET_UNAVAILABLE");
  fs.rmSync(store.storeRoot(instanceRoot), { recursive: true, force: true });
  console.log("PASS K2 a tampered value is refused");

  // K3
  const password = `Pw${crypto.randomBytes(12).toString("hex")}`;
  const script = "console.log('the password is ' + process.env.ANXOS_TEST_PASSWORD); setInterval(() => {}, 1000);";
  const created = await core.createInstance({
    id: "secret-server", displayName: "Secret server", type: "custom-command", executable: process.execPath,
    args: ["-e", script, "%ANXOS_TEST_PASSWORD%"], ports: [], startupTimeoutMs: 2000, readinessMode: "process",
    secretEnvironment: { ANXOS_TEST_PASSWORD: password },
  });
  assert.deepStrictEqual(created.secretEnvironment, [{ name: "ANXOS_TEST_PASSWORD", configured: true }], "the public view shows the name only");
  const configJson = fs.readFileSync(path.join(instanceRoot, "secret-server", "config.json"), "utf8");
  assert.ok(!configJson.includes(password) && JSON.parse(configJson).secretEnvironmentNames.includes("ANXOS_TEST_PASSWORD"), "config.json records the name, never the value");
  await assert.rejects(core.createInstance({ id: "plain-server", type: "custom-command", executable: process.execPath, args: ["-e", "0"], environment: { ADMIN_PASSWORD: "x" } }), (error) => error.code === "SECRET_ENVIRONMENT_NOT_ALLOWED", "the rule against secret-named ordinary settings is unchanged");
  await assert.rejects(core.createInstance({ id: "bad-secret", type: "custom-command", executable: process.execPath, args: ["-e", "0"], secretEnvironment: { ANXOS_X: "a\nb" } }), (error) => error.code === "INVALID_SECRET_ENVIRONMENT");
  console.log("PASS K3 only names are saved and shown; the existing rule still refuses secret-named settings");

  // K4
  await core.startInstance("secret-server");
  const logFile = path.join(instanceRoot, "secret-server", "logs", "stdout.log");
  // The server's own output line (the Launch command line also quotes the script).
  const log = await waitFor(() => { const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""; return /"message":"the password is /.test(text) ? text : null; }, "the server's output");
  const printed = log.split("\n").filter((line) => line.includes("password is")).join(" | ").slice(0, 300);
  assert.match(log, /the password is \[redacted\]/, `the value the server printed is scrubbed from its log (${printed})`);
  assert.ok(!log.includes(password), "the log never holds the value");
  assert.match(log, /Launch command: .*%ANXOS_TEST_PASSWORD%/, "the Launch command line shows the name");
  await core.stopInstance("secret-server");
  await waitFor(async () => (await core.getStatus("secret-server")).state === "Stopped", "stop");
  // An installer run (as SteamCMD's) does not receive the value.
  await core.updateInstance("secret-server", { args: ["-e", "console.log('installer sees ' + (process.env.ANXOS_TEST_PASSWORD || 'nothing'))"] });
  await core.startInstance("secret-server", { role: "installer" });
  const installerLine = await waitFor(() => /"message":"installer sees [^"]*"/.exec(fs.readFileSync(logFile, "utf8"))?.[0], "the installer run's output");
  assert.strictEqual(installerLine, '"message":"installer sees nothing"', `an installer run gets no secret (${installerLine})`);
  await waitFor(async () => (await core.getStatus("secret-server")).state !== "Running", "installer exit");
  assert.deepStrictEqual(containing(password), [], "no file anywhere holds the value");
  console.log("PASS K4 the server gets the value, its logs and Launch command never show it, an installer run does not get it");

  // K5
  const saved = fs.readFileSync(path.join(store.storeRoot(instanceRoot), "secrets.json"), "utf8");
  store.deleteServerSecrets(instanceRoot, "secret-server");
  await assert.rejects(core.startInstance("secret-server"), (error) => {
    assert.strictEqual(error.code, "SERVER_SECRET_UNAVAILABLE");
    assert.match(error.message, /Set a new value/);
    return true;
  }, "a server whose value is missing refuses to start");
  fs.writeFileSync(path.join(store.storeRoot(instanceRoot), "secrets.json"), saved);
  console.log("PASS K5 a missing value refuses the start with a plain reason");

  // K6
  const rotated = `Rt${crypto.randomBytes(12).toString("hex")}`;
  const echoed = await core.updateInstance("secret-server", { secretEnvironment: [{ name: "ANXOS_TEST_PASSWORD", configured: true }] });
  assert.deepStrictEqual(echoed.secretEnvironment.map((entry) => entry.name), ["ANXOS_TEST_PASSWORD"], "sending the public record back changes nothing");
  const updated = await core.updateInstance("secret-server", { secretEnvironment: { ANXOS_TEST_PASSWORD: rotated } });
  assert.deepStrictEqual(updated.secretEnvironment.map((entry) => entry.name), ["ANXOS_TEST_PASSWORD"]);
  assert.strictEqual(store.readServerSecretsForStart(instanceRoot, "secret-server", ["ANXOS_TEST_PASSWORD"]).ANXOS_TEST_PASSWORD, rotated, "an update replaces the value");
  const oldKey = fs.readFileSync(keyFile);
  const rotation = store.rotateServerSecretKey(instanceRoot);
  assert.deepStrictEqual(rotation.unreadable, []);
  assert.notStrictEqual(rotation.keyId, store.keyFingerprint(oldKey));
  assert.strictEqual(store.readServerSecretsForStart(instanceRoot, "secret-server", ["ANXOS_TEST_PASSWORD"]).ANXOS_TEST_PASSWORD, rotated, "values survive a key rotation");
  fs.writeFileSync(keyFile, oldKey);
  assert.throws(() => store.readServerSecretsForStart(instanceRoot, "secret-server", ["ANXOS_TEST_PASSWORD"]), (error) => error.code === "SERVER_SECRET_UNAVAILABLE", "the old key no longer opens the store");
  const external = path.join(root, "external.key");
  fs.writeFileSync(external, crypto.randomBytes(32).toString("hex"));
  process.env.AGENT_SERVER_SECRET_KEY_FILE = external;
  store.setServerSecrets(instanceRoot, "external-server", { ANXOS_X: "value-1234" });
  assert.strictEqual(store.readServerSecretsForStart(instanceRoot, "external-server", ["ANXOS_X"]).ANXOS_X, "value-1234", "an external key file is used");
  assert.throws(() => store.rotateServerSecretKey(instanceRoot), (error) => error.code === "SERVER_SECRET_KEY_EXTERNAL", "an external key is rotated by its owner, not here");
  delete process.env.AGENT_SERVER_SECRET_KEY_FILE;
  console.log("PASS K6 values and the key can be rotated; an external key file is honoured");

  // K7
  await core.deleteInstance("secret-server");
  assert.ok(!JSON.parse(fs.readFileSync(secretsFile, "utf8")).entries["secret-server"], "deleting the server deletes its values");
  console.log("PASS K7 a deleted server's values are deleted");

  // K8 (desktop)
  const agentClient = require(path.join(repo, "src/services/agentClient"));
  const marketplaceService = require(path.join(repo, "src/services/marketplaceService"));
  const { validateMarketplaceTemplate } = require(path.join(repo, "src/services/marketplaceInstallerRegistry"));
  const templates = JSON.parse(fs.readFileSync(path.join(repo, "config/marketplace-templates.json"), "utf8"));
  const pz = templates.find((entry) => entry.id === "project-zomboid");
  assert.ok(pz && Array.isArray(pz.generatedSecrets), "Project Zomboid declares its generated password");
  assert.ok(JSON.stringify(pz.startup).includes("-adminpassword %ANXOS_PZ_ADMIN_PASSWORD%"), "its command names the setting");
  assert.throws(() => validateMarketplaceTemplate({ ...pz, startup: { ...pz.startup, args: ["{secret:x}"] } }), /cannot contain a password/);
  const sent = [];
  let deleted = null;
  agentClient.createInstance = async (payload) => { sent.push(payload); return { instance: { id: payload.id, secretEnvironment: [] } }; };
  agentClient.deleteInstance = async (id) => { deleted = id; return { deleted: true }; };
  agentClient.updateInstance = async (id) => ({ instance: { id } });
  agentClient.checkDependencies = async () => ({ ok: true, dependencies: [] });
  agentClient.getInstanceStatus = async (id) => {
    if (!sent.some((payload) => payload.id === id)) throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND", status: 404 });
    return { instance: { id, state: "Stopped" } };
  };
  agentClient.listInstances = async () => ({ instances: [] });
  await assert.rejects(marketplaceService.installTemplate({ templateId: "project-zomboid", nodeId: "application-host", platform: "windows", requestId: "k8", options: { name: "pz", start: false } }), (error) => {
    assert.strictEqual(error.code, "AGENT_SECRET_STORE_REQUIRED", `an older Agent is refused (${error.code}: ${error.message})`);
    return true;
  });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].secretEnvironment.ANXOS_PZ_ADMIN_PASSWORD, /^[A-Za-z0-9]{24}$/, "the generated password travels only in the write-only field");
  assert.ok(!JSON.stringify(sent[0].environment || {}).includes(sent[0].secretEnvironment.ANXOS_PZ_ADMIN_PASSWORD), "never as an ordinary setting");
  assert.strictEqual(deleted, sent[0].id, "the server an older Agent created is removed");
  console.log("PASS K8 the desktop sends the password only to the secret store and refuses older Agents");
  console.log("Server secret store smoke passed (8 checks).");
}

main()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
