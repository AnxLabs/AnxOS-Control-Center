const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-ssh-profiles-"));
process.env.ANXHUB_CONFIG_DIR = root;
const { SSH_PROFILES_SCHEMA_VERSION, SshService } = require("../src/services/sshService");
const service = new SshService();
const filePath = path.join(root, "ssh-profiles.json");
const legacy = { servers: [{ id: "host-a", displayName: "Host A", host: "10.0.0.2" }], profiles: [{ id: "profile-a", serverId: "host-a", displayName: "Host A", host: "10.0.0.2", port: 22, username: "admin", authType: "password" }], defaultProfileId: "profile-a" };

fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
assert.strictEqual(service.listProfiles().profiles[0].host, "10.0.0.2");
assert.strictEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).schemaVersion, SSH_PROFILES_SCHEMA_VERSION);
assert(fs.existsSync(`${filePath}.schema-v0.backup`), "Legacy SSH profiles should be preserved before migration.");
assert.throws(
  () => service.connect({ profileId: "profile-a", nodeId: "anxlab", password: "unused" }),
  (error) => error?.code === "SSH_NODE_MISMATCH" &&
    /not assigned to the selected node/i.test(error.message) &&
    error.details?.mismatchBlocked === true,
  "Missing nodeId profiles must fail with a clear node assignment error instead of hanging.",
);

let assigned = service.assignProfileToNode("profile-a", "anxlab");
assert.strictEqual(assigned.profiles.find((profile) => profile.id === "profile-a")?.nodeId, "anxlab", "Profile assignment should persist the selected node id.");
const deleted = service.deleteProfile("profile-a");
assert.strictEqual(deleted.profiles.length, 0, "Deleting an SSH profile must remove its saved connection details.");
assert.strictEqual(deleted.servers.length, 0, "Deleting the last profile for a server must remove the orphaned server entry.");

fs.writeFileSync(filePath, `${JSON.stringify({
  schemaVersion: SSH_PROFILES_SCHEMA_VERSION,
  servers: [{ id: "host-b", displayName: "Host B", host: "10.0.0.3", nodeId: "other-node" }],
  profiles: [{ id: "profile-b", serverId: "host-b", displayName: "Host B", host: "10.0.0.3", port: 22, username: "admin", authType: "password", nodeId: "other-node" }],
  defaultProfileId: "profile-b",
})}\n`, { mode: 0o600 });
assert.throws(
  () => service.connect({ profileId: "profile-b", nodeId: "anxlab", password: "unused" }),
  (error) => error?.code === "SSH_NODE_MISMATCH" &&
    error.details?.profileNodeId === "other-node" &&
    error.details?.mismatchBlocked === true,
  "Mismatched nodeId profiles must fail with SSH_NODE_MISMATCH instead of staying in Connecting.",
);

const future = { ...legacy, schemaVersion: SSH_PROFILES_SCHEMA_VERSION + 1 };
fs.writeFileSync(filePath, JSON.stringify(future), { mode: 0o600 });
const futureRaw = fs.readFileSync(filePath, "utf8");
assert.throws(() => service.listProfiles(), (error) => error?.code === "SSH_PROFILES_SCHEMA_UNSUPPORTED");
assert.throws(() => service.saveProfile({ displayName: "New", host: "10.0.0.3", username: "root" }), (error) => error?.code === "SSH_PROFILES_SCHEMA_UNSUPPORTED");
assert.strictEqual(fs.readFileSync(filePath, "utf8"), futureRaw, "Future SSH profile state must not be overwritten.");

fs.writeFileSync(filePath, "{broken", { mode: 0o600 });
const corruptRaw = fs.readFileSync(filePath, "utf8");
assert.throws(() => service.listProfiles(), (error) => error?.code === "SSH_PROFILES_CORRUPT");
assert.throws(() => service.saveProfile({ displayName: "New", host: "10.0.0.3", username: "root" }), (error) => error?.code === "SSH_PROFILES_CORRUPT");
assert.strictEqual(fs.readFileSync(filePath, "utf8"), corruptRaw, "Corrupt SSH profiles must not be overwritten.");
assert(fs.readdirSync(root).some((name) => name.startsWith("ssh-profiles.json.corrupt-") && name.endsWith(".backup")), "Corrupt SSH profiles should be preserved.");
assert.strictEqual(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false, "Atomic SSH profile writes should clean temporary files.");

service.dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log("SSH profile store smoke checks passed.");
