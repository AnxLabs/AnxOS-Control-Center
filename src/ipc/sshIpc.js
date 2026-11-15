const { ipcMain } = require("electron");
const { SshService } = require("../services/sshService");
const { audit, checkRateLimit, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");
const { sanitize } = require("../shared/redaction");

const sshService = new SshService();
let sshIpcRegistered = false;
let lastSshWriteDiagnostic = null;
const authorizedSshSenders = new Set();
// Largest terminal chunk sent to the renderer in one ssh:data event. ssh2
// delivers packets of up to 32 KB, so bigger chunks are split, never cut.
const SSH_DATA_EVENT_MAX_CHARS = 16000;

function authorizeSshRenderer(event) {
  const sender = event?.sender;
  if (sender && typeof sender.send === "function") authorizedSshSenders.add(sender);
}

function sanitizeSshEventPayload(payload = {}) {
  const { session, sessionId, chunk, ...rest } = payload;
  const safePayload = sanitize(rest);
  if (session !== undefined) safePayload.session = sanitize(session);
  if (sessionId !== undefined) safePayload.sessionId = String(sessionId).slice(0, 160);
  // Terminal chunks are the user's own live shell session, not a log or
  // diagnostic. Redacting them corrupts real output (paths, env vars, grep
  // hits) and makes the terminal unusable. Size is bounded by
  // splitTerminalChunk, which keeps every character.
  if (chunk !== undefined) safePayload.chunk = String(chunk);
  return safePayload;
}

function splitTerminalChunk(text, maxChars = SSH_DATA_EVENT_MAX_CHARS) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value ? [value] : [];
  const parts = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maxChars, value.length);
    // Never end a part on the first half of a surrogate pair.
    const lastCode = value.charCodeAt(end - 1);
    if (end < value.length && end - start > 1 && lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

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
  // Generic redaction intentionally hides keys containing "session". SSH event
  // routing requires the non-secret session snapshot and identifier, so preserve
  // those fields explicitly while still redacting their contents.
  const safePayload = sanitizeSshEventPayload(payload);
  for (const sender of [...authorizedSshSenders]) {
    if (sender.isDestroyed?.()) {
      authorizedSshSenders.delete(sender);
      continue;
    }
    sender.send(channel, safePayload);
  }
}

// Node SSH tunnels treat a host-key problem as permanent and never retry it on
// their own, so once the user approves (or replaces) the key, retry the
// tunnels that use this profile. Best effort: approval already succeeded.
function reconnectFailedNodeTunnels(profileId) {
  if (!profileId) return;
  try {
    const tunnels = require("../services/nodeTunnelService").getNodeTunnelService();
    for (const status of tunnels.listStatus()) {
      if (status.sshProfileId === profileId && status.state === "failed") tunnels.reconnect(status.nodeId);
    }
  } catch (error) {
    console.warn("[SSH] Node tunnels could not be retried after the host-key approval.", { code: error?.code || null });
  }
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
    // Send oversized output as consecutive events, in order, so a large
    // `cat` or `journalctl` burst is never silently truncated.
    for (const part of splitTerminalChunk(chunk)) {
      broadcastSshEvent("ssh:data", {
        sessionId,
        chunk: part,
      });
    }
  });

  sshService.on("session-error", (failure) => {
    broadcastSshEvent("ssh:status", {
      type: "session-error",
      ...failure,
    });
  });

  sshService.on("session-closed", ({ sessionId, message }) => {
    broadcastSshEvent("ssh:status", {
      type: "session-closed",
      sessionId,
      message,
    });
  });

  registerSshHandler("ssh:listProfiles", async (event) => {
    requirePermission("ssh:read", "ssh-profiles");
    authorizeSshRenderer(event);
    return sshService.listProfiles();
  });
  registerSshHandler("ssh:saveProfile", async (_, payload = {}) => {
    requirePermission("settings:write", payload.id || payload.name || payload.host);
    audit({ action: "ssh.profile.save", target: payload.id || payload.name || payload.host });
    return sshService.saveProfile(payload);
  });
  registerSshHandler("ssh:deleteProfile", async (_, payload = {}) => {
    requirePermission("settings:write", payload.profileId || "ssh-profile");
    audit({ action: "ssh.profile.delete", target: payload.profileId || "ssh-profile" });
    return sshService.deleteProfile(payload.profileId);
  });
  registerSshHandler("ssh:assignProfileToNode", async (_, payload = {}) => {
    requirePermission("settings:write", payload.profileId || "ssh-profile");
    audit({ action: "ssh.profile.assign-node", target: payload.profileId || "ssh-profile" });
    return sshService.assignProfileToNode(payload.profileId, payload.nodeId);
  });
  registerSshHandler("ssh:setProfileAgent", async (_, payload = {}) => {
    requirePermission("settings:write", payload.profileId || "ssh-profile");
    audit({ action: payload.enabled === true ? "ssh.profile.agent-enable" : "ssh.profile.agent-disable", target: payload.profileId || "ssh-profile" });
    return sshService.setProfileSshAgent(payload.profileId, payload.enabled === true);
  });
  registerSshHandler("ssh:connect", async (event, payload = {}) => {
    requirePermission("instance:write", payload.profileId || payload.host || "ssh-session");
    authorizeSshRenderer(event);
    checkRateLimit("ssh-connect", 30, 60 * 1000);
    audit({ action: "ssh.connect", target: payload.profileId || payload.host });
    return sshService.connect(payload);
  });
  registerSshHandler("ssh:getSession", async (event, payload = {}) => {
    requirePermission("ssh:read", payload.sessionId || "ssh-session");
    authorizeSshRenderer(event);
    return sshService.getSession(payload.sessionId);
  });
  registerSshHandler("ssh:approveHostKey", async (_, payload = {}) => {
    requirePermission("instance:write", payload.profileId || "ssh-host-key");
    const replaceChangedKey = payload.replaceChangedKey === true;
    audit({ action: replaceChangedKey ? "ssh.host-key.replace" : "ssh.host-key.approve", target: payload.profileId || "ssh-host-key" });
    const result = sshService.approveHostKey(payload.profileId, payload.fingerprint, { replaceChangedKey });
    reconnectFailedNodeTunnels(result?.profileId);
    return result;
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
  authorizedSshSenders.clear();
  sshIpcRegistered = false;
}

module.exports = {
  disposeSshIpc,
  registerSshIpc,
  getLastSshWriteDiagnostic: () => (lastSshWriteDiagnostic ? { ...lastSshWriteDiagnostic } : null),
  _test: { sanitizeSshEventPayload, splitTerminalChunk },
};
