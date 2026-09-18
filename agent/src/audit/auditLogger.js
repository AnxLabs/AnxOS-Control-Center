const { correlationMetadata } = require("../../../src/shared/structuredLogger");

function redact(value) {
  return String(value || "")
    .replace(/(\bAuthorization:\s*Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(?:secret|token|password|credential|api[_-]?key)\b\s*[:=]\s*\S+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
}

function getActor(request) {
  return {
    remoteAddress: request.socket?.remoteAddress || null,
    userAgent: redact(request.headers["user-agent"] || ""),
  };
}

// V2-J bullet 2: an Agent action audit line joins the desktop user operation
// that triggered it through the canonical `correlationId` field emitted by the
// shared correlation primitive (the same field name the Agent's structured
// logger writes). The key is only added when an operation scope is active, so
// audit lines emitted outside a scope keep their previous shape exactly.
function auditAction(request, event) {
  console.info(JSON.stringify({
    scope: "agent_action_audit",
    at: new Date().toISOString(),
    actor: getActor(request),
    actionId: event.actionId || null,
    permission: event.permission || null,
    outcome: event.outcome,
    reason: event.reason || null,
    ...correlationMetadata(event.correlationId),
  }));
}

module.exports = {
  auditAction,
};
