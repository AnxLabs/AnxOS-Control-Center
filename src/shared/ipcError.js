const { sanitizeForDiagnostics } = require("./redaction");

const RETRYABLE_CODES = new Set([
  "AGENT_UNAVAILABLE", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "NETWORK_ERROR",
  "REQUEST_TIMEOUT", "TIMEOUT",
]);
const FRIENDLY_MESSAGES = {
  AUTH_UNLOCK_REQUIRED: "Unlock AnxOS to continue.",
  LOCAL_AUTHENTICATION_REQUIRED: "Unlock AnxOS to access saved local credentials.",
  SECURE_SESSION_DECRYPT_FAILED: "Your saved session could not be restored. Please unlock AnxOS again.",
  SECURE_SESSION_CORRUPT: "Your saved session could not be restored. Please unlock AnxOS again.",
  NODE_CREDENTIAL_DECRYPT_FAILED: "Saved node credentials could not be restored. Unlock AnxOS to continue.",
};
const USER_SAFE_UNPREFIXED_CODES = new Set([
  "AUTH_UNLOCK_REQUIRED",
  "LOCAL_AUTHENTICATION_REQUIRED",
  "NODE_CREDENTIAL_DECRYPT_FAILED",
  "SECURE_SESSION_DECRYPT_FAILED",
  "SECURE_SESSION_CORRUPT",
]);

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function projectErrorForIpc(error, seen = new WeakSet()) {
  if (error === null || error === undefined || typeof error !== "object") return error;
  if (seen.has(error)) return "[circular]";
  seen.add(error);

  const projected = {};
  for (const key of ["name", "message", "code", "status", "statusCode"]) {
    if (error[key] !== undefined && error[key] !== null) projected[key] = error[key];
  }
  if (error.response && typeof error.response === "object") {
    projected.response = {
      status: error.response.status ?? null,
      statusText: error.response.statusText ?? null,
      data: error.response.data ?? null,
    };
  }
  if (error.cause !== undefined) projected.cause = projectErrorForIpc(error.cause, seen);
  return projected;
}

function normalizeIpcError(error = {}, options = {}) {
  const payloadError = error?.payload?.error && typeof error.payload.error === "object" ? error.payload.error : {};
  const sourceDetails = firstValue(error?.details, payloadError.details, {}) || {};
  const sanitizedError = sanitizeForDiagnostics(projectErrorForIpc(error));
  const code = String(firstValue(error?.code, payloadError.code, options.code, "IPC_REQUEST_FAILED")).toUpperCase();
  const technicalMessage = String(firstValue(payloadError.message, error?.message, options.fallbackMessage, "Request failed."));
  const friendlyMessage = String(firstValue(
    error?.friendlyMessage,
    sourceDetails.friendlyMessage,
    FRIENDLY_MESSAGES[code],
    options.friendlyMessage,
    technicalMessage,
  ));
  const statusCode = Number(firstValue(
    error?.statusCode,
    error?.status,
    error?.payload?.status,
    sourceDetails.status,
    error?.response?.status,
    error?.cause?.response?.status,
  )) || null;
  const suggestion = firstValue(error?.suggestion, sourceDetails.suggestion, options.suggestion, null);
  const retryable = firstValue(error?.retryable, sourceDetails.retryable, options.retryable, RETRYABLE_CODES.has(code)) === true;
  const provider = firstValue(error?.provider, sourceDetails.provider, options.provider, null);
  const causeCode = firstValue(error?.cause?.code, error?.causeCode, sourceDetails.causeCode, null);
  const sanitized = sanitizeForDiagnostics({
    code,
    friendlyMessage,
    technicalDetails: {
      message: technicalMessage,
      causeCode,
      endpoint: firstValue(sourceDetails.endpoint, sourceDetails.url, error?.endpoint, null),
      method: firstValue(sourceDetails.method, error?.method, null),
      nodeId: firstValue(sourceDetails.nodeId, error?.nodeId, null),
      targetLabel: firstValue(sourceDetails.targetLabel, error?.targetLabel, null),
      cause: sanitizedError?.cause || null,
      response: sanitizedError?.response || null,
    },
    suggestion,
    retryable,
    status: { code: statusCode },
    provider: provider ? { id: provider } : null,
    diagnostics: sourceDetails.diagnostics || null,
    causeCode,
  });
  return sanitized;
}

function createIpcError(error = {}, options = {}) {
  const contract = normalizeIpcError(error, options);
  const message = USER_SAFE_UNPREFIXED_CODES.has(contract.code)
    ? contract.friendlyMessage
    : contract.friendlyMessage.includes(contract.code)
    ? contract.friendlyMessage
    : `${contract.code}: ${contract.friendlyMessage}`;
  const wrapped = new Error(message);
  Object.assign(wrapped, contract, {
    details: {
      code: contract.code,
      technicalDetails: contract.technicalDetails,
      suggestion: contract.suggestion,
      retryable: contract.retryable,
      status: contract.status,
      provider: contract.provider,
      diagnostics: contract.diagnostics,
      causeCode: contract.causeCode,
    },
    statusCode: contract.status?.code || null,
  });
  Object.defineProperty(wrapped, "cause", {
    value: sanitizeForDiagnostics(projectErrorForIpc(error)),
    enumerable: false,
  });
  return wrapped;
}

module.exports = { createIpcError, normalizeIpcError };
