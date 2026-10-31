const { ipcMain } = require("electron");
const { getWebhookAlerts, saveWebhookAlerts, testWebhookAlerts } = require("../services/serviceRouter");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { wrapExpectedAgentRead } = require("./expectedAgentError");

// Server alerts: the selected node's Agent posts crash, scheduled restart and
// update events to a Discord or HTTPS webhook. Reads are masked by the Agent
// (nodes:read); saving the URL or sending a test reaches outside the node, so
// both are settings:write and audited. The URL is only ever sent to the Agent.
const ERROR_ENVELOPE = {
  code: "WEBHOOK_ALERTS_REQUEST_FAILED",
  fallbackMessage: "Server alert settings request failed.",
  suggestion: "Verify the selected node and its Agent connection, then retry.",
};

function registerWebhookAlertsIpc() {
  ipcMain.handle("webhookAlerts:get", async (_, payload = {}) => wrapExpectedAgentRead("webhookAlerts:get", () => {
    requireLocalOwnerAuthenticated("webhookAlerts:get", "Unlock AnxOS to view server alert settings.");
    requirePermission("nodes:read", payload.nodeId);
    const context = requireNodeContext(payload, "server alerts");
    return getWebhookAlerts({ ...payload, nodeId: context.nodeId });
  }, ERROR_ENVELOPE));
  ipcMain.handle("webhookAlerts:save", async (_, payload = {}) => wrapExpectedAgentRead("webhookAlerts:save", () => {
    requireLocalOwnerAuthenticated("webhookAlerts:save", "Unlock AnxOS to change server alerts.");
    requirePermission("settings:write", payload.nodeId);
    const context = requireNodeContext(payload, "server alerts");
    const update = {};
    if (payload.url !== undefined) update.url = payload.url === null ? null : String(payload.url);
    if (payload.enabled !== undefined) update.enabled = payload.enabled !== false;
    if (payload.events !== undefined) update.events = Array.isArray(payload.events) ? payload.events.map(String) : payload.events;
    audit({ action: "webhookAlerts.save", target: context.nodeId, details: { urlChanged: payload.url !== undefined, enabled: update.enabled, events: update.events } });
    return saveWebhookAlerts(update, { nodeId: context.nodeId });
  }, ERROR_ENVELOPE));
  ipcMain.handle("webhookAlerts:test", async (_, payload = {}) => wrapExpectedAgentRead("webhookAlerts:test", () => {
    requireLocalOwnerAuthenticated("webhookAlerts:test", "Unlock AnxOS to send a test alert.");
    requirePermission("settings:write", payload.nodeId);
    const context = requireNodeContext(payload, "server alerts");
    audit({ action: "webhookAlerts.test", target: context.nodeId });
    return testWebhookAlerts({ nodeId: context.nodeId });
  }, ERROR_ENVELOPE));
}

module.exports = {
  registerWebhookAlertsIpc,
};
