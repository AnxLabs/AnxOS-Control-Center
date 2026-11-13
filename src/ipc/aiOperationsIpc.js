"use strict";

// Phase X: IPC for the optional assistant.
//
// The service (and everything behind it) is loaded on the first ai:* call, so
// with AI off the app starts and runs exactly as before. Every channel except
// ai:status needs AI turned on. ai:approve is the only path that runs an
// operation, and it accepts nothing but a proposal id and its digest.

const { ipcMain } = require("electron");
const { audit, requireOwner, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

let loaded = null;
function service() {
  if (!loaded) loaded = require("../services/aiOperationsService").getAiOperationsService();
  return loaded;
}

function wrap(channel, handler) {
  ipcMain.handle(channel, async (_event, payload = {}) => {
    try {
      return await handler(payload && typeof payload === "object" ? payload : {});
    } catch (error) {
      throw createIpcError(error, {
        code: error?.code || "AI_REQUEST_FAILED",
        fallbackMessage: error?.message || "The assistant request failed.",
        suggestion: error?.code === "AI_DISABLED" ? "An Owner can turn AI assistance on in Settings." : "Try again, or use the normal page for this task.",
      });
    }
  });
}

function registerAiOperationsIpc() {
  wrap("ai:status", async () => {
    requirePermission("settings:read", "ai-assistant");
    return service().status();
  });
  wrap("ai:testProvider", async () => {
    requireOwner("ai-assistant-provider");
    audit({ action: "ai.provider.test", target: "ai-assistant" });
    return service().testProvider();
  });
  wrap("ai:ask", async (payload) => {
    requirePermission("nodes:read", "ai-assistant");
    return service().ask({ question: payload.question, context: payload.context });
  });
  wrap("ai:proposeRepair", async (payload) => {
    requirePermission("nodes:read", "ai-assistant");
    return service().proposeRepair({ tool: payload.tool, target: payload.target });
  });
  // Approve/reject/cancel use the same IPC guard as asking; running an
  // approved operation then re-checks the tool's own permission (for example
  // instance:lifecycle) in the service.
  wrap("ai:approve", async (payload) => {
    requirePermission("nodes:read", "ai-assistant");
    return service().approve(payload);
  });
  wrap("ai:reject", async (payload) => {
    requirePermission("nodes:read", "ai-assistant");
    return service().reject({ proposalId: payload.proposalId });
  });
  wrap("ai:cancel", async () => {
    requirePermission("nodes:read", "ai-assistant");
    return loaded ? loaded.cancel() : { cancelledQuestions: 0 };
  });
  wrap("ai:history", async () => {
    requirePermission("nodes:read", "ai-assistant");
    return service().history();
  });
}

// Settings changed. Turning AI off cancels waiting proposals and model calls;
// operations already running finish and are recorded.
function notifyAiSettingsSaved(settings = {}) {
  if (!loaded) return null;
  if (Object.prototype.hasOwnProperty.call(settings, "ai.enabled") && settings["ai.enabled"] !== true) return loaded.onDisabled();
  return null;
}

module.exports = {
  notifyAiSettingsSaved,
  registerAiOperationsIpc,
};
