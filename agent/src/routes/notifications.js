const {
  getNotificationSettings,
  saveNotificationSettings,
  sendTestNotification,
} = require("../services/notificationService");

function parseJsonBody(request) {
  if (!request.body) return {};
  try {
    return JSON.parse(request.body);
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { code: "INVALID_JSON", statusCode: 400 });
  }
}

const MESSAGES = Object.freeze({
  NOTIFICATION_WEBHOOK_INVALID: "Enter a valid HTTPS webhook URL.",
  NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED: "The webhook must use a public host name, not an IP address or a local name.",
  NOTIFICATION_EVENTS_INVALID: "One or more alert events are not recognised.",
  NOTIFICATION_WEBHOOK_NOT_CONFIGURED: "Save a webhook URL before sending a test alert.",
  NOTIFICATION_STORE_CORRUPT: "The alert settings on this node could not be read.",
});

// Server alerts (one webhook per node). Reads are masked; GET is system:read,
// writes and test sends are agent:manage (server.js getRoutePermission).
async function handleNotifications(request, url) {
  try {
    if (url.pathname === "/api/v1/notifications/webhook" && request.method === "GET") {
      return { statusCode: 200, body: await getNotificationSettings() };
    }
    if (url.pathname === "/api/v1/notifications/webhook" && request.method === "PUT") {
      return { statusCode: 200, body: await saveNotificationSettings(parseJsonBody(request)) };
    }
    if (url.pathname === "/api/v1/notifications/webhook/test" && request.method === "POST") {
      return { statusCode: 200, body: await sendTestNotification() };
    }
    return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Request failed." } } };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: { error: { code: error.code || "NOTIFICATION_REQUEST_FAILED", message: MESSAGES[error.code] || "Request failed." } },
    };
  }
}

module.exports = { handleNotifications };
