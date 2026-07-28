const diagnostics = require("./diagnosticsService");

const AUTH_STATES = Object.freeze({
  FRESH_SETUP_REQUIRED: "fresh_setup_required",
  LOCAL_CREDENTIALS_LOCKED: "local_credentials_locked",
  LOCKED_RECOVERABLE: "locked_recoverable",
  LOCKED: "locked",
  UNLOCKING: "unlocking",
  UNLOCKED: "unlocked",
  RESTORE_PENDING: "restore_pending",
  RESTORE_FAILED: "restore_failed",
});

const RECOVERY_MESSAGE = "Your saved session could not be restored. Please unlock AnxOS again.";
const UNLOCK_MESSAGE = "Unlock AnxOS to continue.";
const LOCAL_CREDENTIALS_MESSAGE = "Saved node credentials could not be restored. Unlock AnxOS to continue.";
let state = AUTH_STATES.LOCKED;
let failureCode = null;
let recoveryActive = false;
let recoveryReason = null;
let blockedDiagnostics = new Map();

function log(level, operation, message, context = {}, errorCode = null) {
  diagnostics.log(level, "authentication", operation, message, context, { file: "auth", errorCode });
}

function enterRestorePending() {
  if (state !== AUTH_STATES.LOCKED_RECOVERABLE) state = AUTH_STATES.RESTORE_PENDING;
  return getState();
}

function enterLockedRecoverable(error, context = {}) {
  const firstFailure = state !== AUTH_STATES.LOCKED_RECOVERABLE;
  state = AUTH_STATES.LOCKED_RECOVERABLE;
  recoveryActive = true;
  recoveryReason = context.reason || "secure_session_unavailable";
  failureCode = String(error?.code || "SECURE_SESSION_RESTORE_FAILED");
  if (firstFailure) {
    log("warn", "secure-session-restore", "Secure session restore failed; encrypted state was preserved", {
      preserved: true,
      source: context.source || "saved-session",
    }, failureCode);
    log("info", "auth-state", "Entered recoverable locked authentication state", {}, failureCode);
  }
  return getState();
}

function enterLocalCredentialsLocked(context = {}) {
  state = AUTH_STATES.LOCAL_CREDENTIALS_LOCKED;
  recoveryActive = true;
  recoveryReason = context.reason || "node_credentials_unavailable";
  failureCode = null;
  return getState();
}

function enterUnlocking() {
  state = AUTH_STATES.UNLOCKING;
  return getState();
}

function enterUnlocked(context = {}) {
  state = AUTH_STATES.UNLOCKED;
  recoveryActive = false;
  recoveryReason = null;
  failureCode = null;
  blockedDiagnostics.clear();
  log("info", "auth-state", "Local Owner unlock completed", { provider: context.provider || "local-owner" });
  return getState();
}

function enterLocked(options = {}) {
  state = recoveryActive ? AUTH_STATES.LOCKED_RECOVERABLE : options.setupRequired ? AUTH_STATES.FRESH_SETUP_REQUIRED : AUTH_STATES.LOCKED;
  failureCode = null;
  if (!recoveryActive) recoveryReason = null;
  return getState();
}

function getState() {
  return {
    state,
    lockedRecoverable: recoveryActive,
    authenticated: state === AUTH_STATES.UNLOCKED,
    reason: recoveryReason,
    message: recoveryActive
      ? recoveryReason === "node_credentials_unavailable" ? LOCAL_CREDENTIALS_MESSAGE : RECOVERY_MESSAGE
      : null,
  };
}

function requireUnlocked(target = "protected-action", message = UNLOCK_MESSAGE) {
  if (state !== AUTH_STATES.LOCKED_RECOVERABLE) return;
  const now = Date.now();
  const last = blockedDiagnostics.get(target) || 0;
  if (now - last >= 5000) {
    blockedDiagnostics.set(target, now);
    log("info", "protected-action-blocked", "Protected action blocked until local Owner unlock", { target, deduplicated: last > 0 });
  }
  const error = new Error(message);
  error.code = "AUTH_UNLOCK_REQUIRED";
  error.friendlyMessage = message;
  error.details = { friendlyMessage: message, authState: state };
  throw error;
}

function requireLocalCredentialsUnlocked(target = "protected-local-action", message = UNLOCK_MESSAGE) {
  if (state === AUTH_STATES.UNLOCKED) return;
  const now = Date.now();
  const last = blockedDiagnostics.get(target) || 0;
  if (now - last >= 5000) {
    blockedDiagnostics.set(target, now);
    log("info", "protected-action-blocked", "Protected action blocked until local Owner unlock", { target, deduplicated: last > 0 });
  }
  const error = new Error(message);
  error.code = "LOCAL_AUTHENTICATION_REQUIRED";
  error.friendlyMessage = message;
  error.details = { friendlyMessage: message, authState: state, reason: recoveryReason || "local_credentials_locked" };
  throw error;
}

module.exports = {
  AUTH_STATES,
  RECOVERY_MESSAGE,
  LOCAL_CREDENTIALS_MESSAGE,
  UNLOCK_MESSAGE,
  enterLocked,
  enterLockedRecoverable,
  enterLocalCredentialsLocked,
  enterRestorePending,
  enterUnlocked,
  enterUnlocking,
  getState,
  requireLocalCredentialsUnlocked,
  requireUnlocked,
};
