const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");

const handlers = new Map();
const rendererEvents = [];
let failConnect = false;
let serviceInstance = null;

class MockSshService extends EventEmitter {
  async listProfiles() { return { profiles: [] }; }
  async saveProfile() { return {}; }
  async deleteProfile() { return {}; }
  async getSession() { return {}; }
  async connect() {
    if (failConnect) {
      throw Object.assign(new Error("password=ssh-secret Authorization: Bearer ssh-token"), {
        code: "SSH_AUTHENTICATION_FAILED",
        status: 401,
        details: { diagnostics: { privateKey: "private-material" } },
      });
    }
    return { session: { id: "session-a", connected: true } };
  }
  async disconnect() { return {}; }
  async write() { return {}; }
  async resize() { return {}; }
  dispose() {}
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    };
  }
  if (request === "../services/sshService") return { SshService: MockSshService };
  if (request === "../services/securityService") return { audit: () => {}, checkRateLimit: () => {}, requirePermission: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  serviceInstance = require("../src/ipc/sshIpc").registerSshIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const connect = handlers.get("ssh:connect");
  const sender = { id: 7, isDestroyed: () => false, send: (channel, payload) => rendererEvents.push({ channel, payload }) };
  assert.deepStrictEqual(await connect({ sender }, { profileId: "profile-a" }), { session: { id: "session-a", connected: true } });
  failConnect = true;
  await assert.rejects(connect({ sender }, { profileId: "profile-a" }), (error) => {
    assert.strictEqual(error.code, "SSH_AUTHENTICATION_FAILED");
    assert.strictEqual(error.statusCode, 401);
    const serialized = JSON.stringify(error);
    assert(!serialized.includes("ssh-secret"));
    assert(!serialized.includes("ssh-token"));
    assert(!serialized.includes("private-material"));
    return true;
  });

  serviceInstance.emit("session-error", { sessionId: "session-a", code: "SSH_FAILED", message: "password=event-secret" });
  serviceInstance.emit("session-output", { sessionId: "session-a", chunk: "Authorization: Bearer output-secret" });
  const operationalWorkingDirectory = "/srv/Game Servers/Palworld";
  serviceInstance.emit("session-updated", { id: "session-a", connected: true, workingDirectory: operationalWorkingDirectory });
  const serializedEvents = JSON.stringify(rendererEvents);
  assert(!serializedEvents.includes("event-secret"));
  assert(!serializedEvents.includes("output-secret"));
  assert(serializedEvents.includes("[redacted]"));
  assert(rendererEvents.some((event) => event.payload?.session?.workingDirectory === "[redacted-path] Servers/Palworld"), "SSH operational session state must retain default sanitizer behavior rather than enabling full path-field redaction.");
  console.log("SSH IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
