const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");

const handlers = new Map();
let serviceInvoked = false;
let rendererEventCount = 0;
let sshServiceInstance = null;

class MockSshService extends EventEmitter {
  async listProfiles() { serviceInvoked = true; return []; }
  async saveProfile() { serviceInvoked = true; return {}; }
  async deleteProfile() { serviceInvoked = true; return {}; }
  async connect() { serviceInvoked = true; return {}; }
  async getSession() { serviceInvoked = true; return {}; }
  async disconnect() { serviceInvoked = true; return {}; }
  async write() { serviceInvoked = true; return {}; }
  async resize() { serviceInvoked = true; return {}; }
  dispose() {}
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => { rendererEventCount += 1; } } }] },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    };
  }
  if (request === "../services/sshService") return { SshService: MockSshService };
  if (request === "../services/securityService") {
    return {
      audit: () => {},
      checkRateLimit: () => {},
      requirePermission: () => {
        throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" });
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const sshIpc = require("../src/ipc/sshIpc");
  sshServiceInstance = sshIpc.registerSshIpc();
  const safeStatus = sshIpc._test.sanitizeSshEventPayload({ type: "session-updated", session: { id: "session-a", status: "connected" } });
  assert.deepStrictEqual(safeStatus.session, { id: "session-a", status: "connected" }, "SSH status sanitization must preserve the non-secret session snapshot.");
  const safeData = sshIpc._test.sanitizeSshEventPayload({ sessionId: "session-a", chunk: "hello" });
  assert.strictEqual(safeData.sessionId, "session-a", "SSH data sanitization must preserve the routing session identifier.");
  assert.strictEqual(safeData.chunk, "hello", "SSH data sanitization must preserve safe terminal output.");
} finally {
  Module._load = originalLoad;
}

async function main() {
  for (const channel of ["ssh:listProfiles", "ssh:saveProfile", "ssh:deleteProfile", "ssh:connect", "ssh:getSession", "ssh:approveHostKey", "ssh:disconnect", "ssh:write", "ssh:resize"]) {
    serviceInvoked = false;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    await assert.rejects(
      () => handler({}, { id: "profile-a", profileId: "profile-a", host: "host.test", sessionId: "session-a", input: "whoami\n" }),
      (error) => error?.code === "PERMISSION_DENIED",
      `${channel} should reject an unauthorized renderer request.`,
    );
    assert.strictEqual(serviceInvoked, false, `${channel} must authorize before calling its service.`);
  }
  sshServiceInstance.emit("session-output", { sessionId: "session-a", chunk: "secret output" });
  sshServiceInstance.emit("session-updated", { id: "session-a", state: "connected" });
  assert.strictEqual(rendererEventCount, 0, "SSH events must not reach a renderer after read authorization is denied.");
  console.log("SSH IPC authorization smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
