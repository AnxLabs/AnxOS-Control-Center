const { BrowserWindow, ipcMain } = require("electron");
const { SshService } = require("../services/sshService");
const { audit, checkRateLimit, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");
const { sanitize } = require("../shared/redaction");

const sshService = new SshService();
let sshIpcRegistered = false;
let lastSshWriteDiagnostic = null;

function registerSshHandler(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw createIpcError(error, {
        code: "SSH_REQUEST_FAILED",
        fallbackMessage: "SSH operation failed.",
        suggestion: "Verify the SSH profile, credentials, network path, and remote permissions, then retry.",
      });
    }
  });
}

function broadcastSshEvent(channel, payload) {
  try {
    requirePermission("ssh:read", payload?.sessionId || "ssh-session");
  } catch {
    return;
  }
  const safePayload = sanitize(payload);
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, safePayload);
    }
  });
}

function registerSshIpc() {
  if (sshIpcRegistered) {
    return sshService;
  }

  sshIpcRegistered = true;

  sshService.on("session-updated", (session) => {
    broadcastSshEvent("ssh:status", {
      type: "session-updated",
      session,
    });
  });

  sshService.on("session-output", ({ sessionId, chunk }) => {
    broadcastSshEvent("ssh:data", {
      sessionId,
      chunk,
    });
  });

  sshService.on("session-error", ({ sessionId, message, code }) => {
    broadcastSshEvent("ssh:status", {
      type: "session-error",
      sessionId,
      message,
      code,
    });
  });

  sshService.on("session-closed", ({ sessionId, message }) => {
    broadcastSshEvent("ssh:status", {
      type: "session-closed",
      sessionId,
      message,
    });
  });

  registerSshHandler("ssh:listProfiles", async () => {
    requirePermission("ssh:read", "ssh-profiles");
    return sshService.listProfiles();
  });
  registerSshHandler("ssh:saveProfile", async (_, payload = {}) => {
    requirePermission("settings:write", payload.id || payload.name || payload.host);
    audit({ action: "ssh.profile.save", target: payload.id || payload.name || payload.host });
    return sshService.saveProfile(payload);
  });
  registerSshHandler("ssh:assignProfileToNode", async (_, payload = {}) => {
    requirePermission("settings:write", payload.profileId || "ssh-profile");
    audit({ action: "ssh.profile.assign-node", target: payload.profileId || "ssh-profile" });
    return sshService.assignProfileToNode(payload.profileId, payload.nodeId);
  });
  registerSshHandler("ssh:connect", async (_, payload = {}) => {
    requirePermission("instance:write", payload.profileId || payload.host || "ssh-session");
    checkRateLimit("ssh-connect", 30, 60 * 1000);
    audit({ action: "ssh.connect", target: payload.profileId || payload.host });
    return sshService.connect(payload);
  });
  registerSshHandler("ssh:disconnect", async (_, payload = {}) => {
    requirePermission("instance:write", payload.sessionId);
    audit({ action: "ssh.disconnect", target: payload.sessionId });
    return sshService.disconnect(payload.sessionId);
  });
  registerSshHandler("ssh:write", async (_, payload = {}) => {
    requirePermission("instance:write", payload.sessionId);
    checkRateLimit("ssh-write", 600, 60 * 1000);
    lastSshWriteDiagnostic = {
      ipcReceived: true,
      byteLength: Buffer.byteLength(typeof payload.input === "string" ? payload.input : "", "utf8"),
      sessionPresent: Boolean(payload.sessionId),
      updatedAt: new Date().toISOString(),
    };
    audit({ action: "ssh.input", target: payload.sessionId, reason: `bytes:${lastSshWriteDiagnostic.byteLength}` });
    return sshService.write(payload.sessionId, payload.input);
  });
  registerSshHandler("ssh:resize", async (_, payload = {}) => {
    requirePermission("instance:write", payload.sessionId);
    return sshService.resize(payload.sessionId, payload);
  });
  return sshService;
}

function disposeSshIpc() {
  sshService.dispose();
  sshIpcRegistered = false;
}

module.exports = {
  disposeSshIpc,
  registerSshIpc,
  getLastSshWriteDiagnostic: () => (lastSshWriteDiagnostic ? { ...lastSshWriteDiagnostic } : null),
};
