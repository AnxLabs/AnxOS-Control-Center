const { ipcMain } = require("electron");
const anxnet = require("../services/anxnetService");
const { audit, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// AnxNet (Phase 6). Same tiers as Public Access: reading status is
// public-access:read; anything that changes the network, shares a server or
// publishes it is the owner-only instance:write tier and is audited. Expected
// refusals (not in a network, invite expired, no gateway...) come back as
// { ok: false, error } instead of being logged as failures.

const EXPECTED = /^ANXNET_|^ECONNREFUSED$|^ETIMEDOUT$|^ENOTFOUND$/;

function invoke(channel, operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      const code = String(error?.code || "");
      if (EXPECTED.test(code)) return { ok: false, error: { code, message: error.message } };
      throw createIpcError(error, { code: "ANXNET_REQUEST_FAILED", fallbackMessage: "The AnxNet request failed." });
    });
}

function read(channel, operation) {
  ipcMain.handle(channel, (_, payload = {}) => invoke(channel, () => { requirePermission("public-access:read", "anxnet"); return operation(payload); }));
}

function write(channel, action, operation) {
  ipcMain.handle(channel, (_, payload = {}) => invoke(channel, () => {
    requirePermission("instance:write", "anxnet");
    audit({ action, target: String(payload.target || payload.deviceId || payload.serviceId || "anxnet").slice(0, 120) });
    return operation(payload);
  }));
}

function registerAnxNetIpc() {
  read("anxnet:status", () => anxnet.status());
  write("anxnet:createNetwork", "anxnet.network.create", (payload) => anxnet.createNetwork({ name: payload.name, deviceName: payload.deviceName }));
  write("anxnet:joinNetwork", "anxnet.network.join", (payload) => anxnet.joinNetwork({ code: payload.code, deviceName: payload.deviceName }));
  write("anxnet:leaveNetwork", "anxnet.network.leave", () => anxnet.leaveNetwork());
  write("anxnet:renameNetwork", "anxnet.network.rename", (payload) => anxnet.renameNetwork(String(payload.name || "")));
  write("anxnet:createInvite", "anxnet.invite.create", (payload) => anxnet.createInvite({ ttlMinutes: payload.ttlMinutes, maxUses: payload.maxUses, preApproved: payload.preApproved === true, label: payload.label }));
  write("anxnet:revokeInvite", "anxnet.invite.revoke", (payload) => anxnet.revokeInvite(String(payload.inviteId || "")));
  write("anxnet:approveDevice", "anxnet.device.approve", (payload) => anxnet.approveDevice(String(payload.deviceId || "")));
  write("anxnet:rejectDevice", "anxnet.device.reject", (payload) => anxnet.rejectDevice(String(payload.deviceId || "")));
  write("anxnet:revokeDevice", "anxnet.device.revoke", (payload) => anxnet.revokeDevice(String(payload.deviceId || "")));
  write("anxnet:renameDevice", "anxnet.device.rename", (payload) => anxnet.renameDevice(String(payload.deviceId || ""), String(payload.name || "")));
  write("anxnet:setEdges", "anxnet.edges.set", (payload) => anxnet.setEdges({ relays: payload.relays, gateways: payload.gateways }));
  write("anxnet:setDirectInbound", "anxnet.settings.directInbound", (payload) => anxnet.setDirectInbound(payload.enabled !== false));
  write("anxnet:shareService", "anxnet.service.share", (payload) => anxnet.shareService({
    name: payload.name,
    port: payload.port,
    protocol: payload.protocol,
    targetHost: payload.targetHost,
    targetPort: payload.targetPort,
    allow: payload.allow,
    instanceId: payload.instanceId,
  }));
  write("anxnet:unshareService", "anxnet.service.unshare", (payload) => anxnet.unshareService(String(payload.serviceId || "")));
  write("anxnet:publishService", "anxnet.service.publish", (payload) => anxnet.publishService({ serviceId: String(payload.serviceId || ""), publicHost: payload.publicHost }));
  write("anxnet:unpublishService", "anxnet.service.unpublish", (payload) => anxnet.unpublishService(String(payload.serviceId || "")));
  write("anxnet:testPeer", "anxnet.peer.test", (payload) => anxnet.testPeer(String(payload.deviceId || "")));
}

module.exports = { registerAnxNetIpc };
